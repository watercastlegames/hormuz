/**
 * HORMUZ 다국어 엔진.
 *
 * 페이지를 언어별로 따로 만들지 않는다. 같은 DOM에서 문구만 교체한다.
 *
 * 언어 결정 우선순위
 *   1. ?lang=ko|en          — 명시 지정. 링크 공유·QA용
 *   2. localStorage 저장값   — 사용자가 토글로 고른 값
 *   3. 접속 IP의 국가        — Cloudflare /cdn-cgi/trace 의 loc
 *   4. 타임존·브라우저 언어   — IP 조회 실패 시 폴백
 *   5. 기본값 en            — 한국이 확인되지 않으면 영어
 *
 * 정적 사이트라 서버가 없으므로 IP 판별은 Cloudflare 추적 엔드포인트를 쓴다.
 * 키가 필요 없고 응답이 한 줄짜리 평문이며, 실패해도 폴백이 있으므로
 * 부팅을 막지 않는다(상한 1.5초).
 */

export const SUPPORTED = ["ko", "en"];
export const DEFAULT_LANG = "en";
export const KOREAN_LANG = "ko";

const STORAGE_KEY = "hormuzLangV1";
const GEO_CACHE_KEY = "hormuzGeoCountryV1";
// 이 조회는 시작 화면을 막지 않고 뒤에서 도므로 넉넉히 준다.
// 1.5초로는 차가운 TLS 핸드셰이크가 끝나기 전에 끊겨 국가 판별이 자주 실패했다.
const GEO_TIMEOUT_MS = 4000;
const GEO_ATTEMPTS = 2;
const GEO_RETRY_DELAY_MS = 2500;

const CLOUDFLARE_TRACE = "https://www.cloudflare.com/cdn-cgi/trace";

/**
 * 동일 출처가 Cloudflare 뒤에 있으면 첫 번째 후보에서 바로 끝난다.
 * 로컬 개발 서버는 이 경로가 항상 404이므로 아예 시도하지 않는다.
 * 쓸모없는 요청과 콘솔 404를 만들지 않기 위해서다.
 */
function traceUrls() {
  const host = location.hostname;
  const local = host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "";
  return local ? [CLOUDFLARE_TRACE] : ["/cdn-cgi/trace", CLOUDFLARE_TRACE];
}

let current = DEFAULT_LANG;
let dictionaries = { ko: {}, en: {} };
const listeners = new Set();

/* ------------------------------------------------------------------ */
/* 언어 판별                                                            */
/* ------------------------------------------------------------------ */

function normalize(value) {
  const lang = String(value || "").trim().toLowerCase().slice(0, 2);
  return SUPPORTED.includes(lang) ? lang : null;
}

export function langFromQuery(search = location.search) {
  return normalize(new URLSearchParams(search).get("lang"));
}

export function storedLang() {
  try {
    return normalize(localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

export function storeLang(lang) {
  try {
    localStorage.setItem(STORAGE_KEY, normalize(lang) || DEFAULT_LANG);
  } catch {
    /* 사생활 보호 모드 등에서 저장이 막혀도 게임은 계속된다. */
  }
}

/** 브라우저가 자체적으로 아는 신호. 네트워크를 쓰지 않으므로 항상 즉시 답한다. */
export function localeGuess() {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    if (zone === "Asia/Seoul") return KOREAN_LANG;
  } catch {
    /* 무시하고 언어 목록으로 넘어간다. */
  }
  const languages = [
    ...(Array.isArray(navigator.languages) ? navigator.languages : []),
    navigator.language,
  ].filter(Boolean);
  if (languages.some((value) => String(value).toLowerCase().startsWith("ko"))) {
    return KOREAN_LANG;
  }
  return null;
}

function parseTrace(text) {
  const match = /(?:^|\n)loc=([A-Z]{2})/.exec(String(text || ""));
  return match ? match[1] : null;
}

async function traceOnce(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEO_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
    return response.ok ? parseTrace(await response.text()) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 접속 IP의 국가 코드를 조회한다. 한 세션 안에서는 한 번만 실제로 나간다.
 * 실패하면 null 을 돌려주고, 호출부가 타임존 폴백으로 넘어간다.
 *
 * 부팅 직후에는 번들·모델·텍스처가 동시에 내려와 첫 시도가 자주 끊긴다.
 * 그래서 한 차례 쉬었다가 다시 시도하고, 두 번 모두 실패했을 때만 실패를 기록한다.
 */
export async function detectCountry() {
  try {
    const cached = sessionStorage.getItem(GEO_CACHE_KEY);
    if (cached) return cached === "??" ? null : cached;
  } catch {
    /* 세션 저장소가 없으면 매번 조회한다. */
  }

  let country = null;
  for (let attempt = 0; attempt < GEO_ATTEMPTS && !country; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, GEO_RETRY_DELAY_MS));
    }
    for (const url of traceUrls()) {
      country = await traceOnce(url);
      if (country) break;
    }
  }

  try {
    sessionStorage.setItem(GEO_CACHE_KEY, country || "??");
  } catch {
    /* 저장 실패는 무시한다. */
  }
  return country;
}

/**
 * 최종 언어를 결정한다. 명시 지정과 저장값이 있으면 네트워크를 아예 쓰지 않는다.
 * 반환값의 source 는 QA 에서 어느 단계가 결정했는지 확인하는 데 쓴다.
 */
export async function resolveLang() {
  const queryLang = langFromQuery();
  if (queryLang) return { lang: queryLang, source: "query", country: null };

  const saved = storedLang();
  if (saved) return { lang: saved, source: "stored", country: null };

  const country = await detectCountry();
  if (country) {
    return {
      lang: country === "KR" ? KOREAN_LANG : DEFAULT_LANG,
      source: "geoip",
      country,
    };
  }

  const guess = localeGuess();
  if (guess) return { lang: guess, source: "locale", country: null };

  return { lang: DEFAULT_LANG, source: "default", country: null };
}

/**
 * 시작 화면을 막지 않는 초기화.
 *
 * 1) 네트워크가 필요 없는 신호로 즉시 언어를 정하고 화면을 그린다.
 * 2) IP 국가 조회는 뒤에서 돌리고, 사용자가 직접 고르지 않은 경우에만
 *    결과가 다를 때 조용히 바꾼다.
 *
 * 시작 화면 즉시 표시가 정본 요구사항이므로 여기서 await 하지 않는다.
 */
export function initLang() {
  const explicit = langFromQuery() || storedLang();
  const immediate = explicit || localeGuess() || DEFAULT_LANG;
  setLang(immediate, { persist: false, silent: true });

  const info = {
    lang: immediate,
    source: explicit ? (langFromQuery() ? "query" : "stored") : "locale",
    country: null,
    pending: !explicit,
  };
  if (typeof window !== "undefined") {
    window.__HORMUZ_I18N__ = info;
    // QA 에서 국가 판별만 따로 돌려볼 수 있게 열어 둔다.
    window.__HORMUZ_DETECT_COUNTRY__ = detectCountry;
  }
  if (explicit) return info;

  detectCountry().then((country) => {
    info.country = country;
    info.pending = false;
    if (!country) return;
    info.source = "geoip";
    const byCountry = country === "KR" ? KOREAN_LANG : DEFAULT_LANG;
    info.lang = byCountry;
    // 그사이 사용자가 직접 골랐다면 그 선택을 이긴다.
    if (storedLang()) return;
    if (byCountry !== current) setLang(byCountry, { persist: false });
  });
  return info;
}

/* ------------------------------------------------------------------ */
/* 사전과 치환                                                          */
/* ------------------------------------------------------------------ */

export function loadDictionaries({ ko, en }) {
  dictionaries = { ko: ko || {}, en: en || {} };
}

export function getLang() {
  return current;
}

export function isKorean() {
  return current === KOREAN_LANG;
}

/** 언어를 바꾸고 구독자에게 알린다. 저장은 사용자가 직접 고른 경우에만 한다. */
export function setLang(lang, { persist = true, silent = false } = {}) {
  const next = normalize(lang) || DEFAULT_LANG;
  const changed = next !== current;
  current = next;
  if (persist) storeLang(next);
  applyDocumentLang();
  if (changed && !silent) listeners.forEach((listener) => listener(next));
  return next;
}

export function onLangChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * 사전 조회. 키가 없으면 반대 언어, 그래도 없으면 키 자체를 돌려준다.
 * 화면이 비는 것보다 키가 보이는 편이 낫고, QA 에서 즉시 눈에 띈다.
 */
export function t(key, vars) {
  const primary = dictionaries[current] || {};
  const fallback = dictionaries[current === "ko" ? "en" : "ko"] || {};
  let value = primary[key];
  if (value === undefined) value = fallback[key];
  if (value === undefined) {
    // 사전 로드 자체가 실패한 비상 경로. vars 를 버리면 오류 메시지 같은
    // 진단 정보가 통째로 사라지므로 키 옆에 원시 값을 같이 보여준다.
    if (!vars) return key;
    const extra = Object.entries(vars).map(([name, item]) => `${name}=${item}`).join(", ");
    return `${key} (${extra})`;
  }
  return vars ? format(value, vars) : value;
}

export function hasKey(key) {
  return (dictionaries[current] || {})[key] !== undefined;
}

/** "{day}일차" 같은 자리표시자를 채운다. */
export function format(template, vars = {}) {
  return String(template).replace(/\{(\w+)\}/g, (match, name) => (
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match
  ));
}

/**
 * 데이터 JSON 의 이중 필드를 고른다.
 * 영어일 때 `titleEn` 이 있으면 그것을, 없으면 한국어 원문을 쓴다.
 * 번역이 아직 안 들어온 항목이 있어도 화면이 비지 않는다.
 */
export function pick(source, field) {
  if (!source) return "";
  if (current !== KOREAN_LANG) {
    const english = source[`${field}En`];
    if (english !== undefined && english !== null && english !== "") return english;
  }
  const korean = source[field];
  if (korean !== undefined && korean !== null) return korean;
  const legacyKorean = source[`${field}Ko`];
  return legacyKorean === undefined || legacyKorean === null ? "" : legacyKorean;
}

/* ------------------------------------------------------------------ */
/* 정적 마크업 치환                                                      */
/* ------------------------------------------------------------------ */

/**
 * data-i18n 계열 속성이 붙은 노드를 현재 언어로 갱신한다.
 *   data-i18n            텍스트
 *   data-i18n-html       HTML (줄바꿈·강조가 필요한 문구)
 *   data-i18n-attr       "속성:키" 목록, 쉼표로 구분. 예) "aria-label:hud.map,title:hud.map"
 */
export function applyStaticI18n(root = document) {
  root.querySelectorAll("[data-i18n]").forEach((node) => {
    node.textContent = t(node.dataset.i18n);
  });
  root.querySelectorAll("[data-i18n-html]").forEach((node) => {
    node.innerHTML = t(node.dataset.i18nHtml);
  });
  root.querySelectorAll("[data-i18n-attr]").forEach((node) => {
    node.dataset.i18nAttr.split(",").forEach((pair) => {
      const [attribute, key] = pair.split(":").map((part) => part.trim());
      if (attribute && key) node.setAttribute(attribute, t(key));
    });
  });
  applyDocumentLang();
}

/**
 * <html lang>, 문서 제목, 검색용 설명을 현재 언어에 맞춘다.
 * 게임이 아닌 페이지(개발자 정보 등)는 <html> 의 data-i18n-title-key /
 * data-i18n-description-key 로 자기 키를 지정한다. 없으면 게임 기본 키를 쓴다.
 */
export function applyDocumentLang() {
  document.documentElement.lang = current;
  const dataset = document.documentElement.dataset;
  const titleKey = dataset.i18nTitleKey || "meta.title";
  const descriptionKey = dataset.i18nDescriptionKey || "meta.description";
  const title = t(titleKey);
  if (title && title !== titleKey) document.title = title;
  const description = document.querySelector('meta[name="description"]');
  const descriptionText = t(descriptionKey);
  if (description && descriptionText && descriptionText !== descriptionKey) {
    description.setAttribute("content", descriptionText);
  }
}

/** 전투 iframe 등 하위 화면으로 언어를 넘길 때 쓴다. */
export function withLang(url) {
  const next = new URL(url, location.href);
  next.searchParams.set("lang", current);
  return next;
}
