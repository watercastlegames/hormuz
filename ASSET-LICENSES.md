# Asset licenses / 자산 라이선스

The root `LICENSE` applies to the original game code and documentation unless a file says
otherwise. Bundled assets have these additional terms:

| Asset | License | Attribution / source |
|---|---|---|
| HORMUZ 3D models in `assets/models/` | CC BY 4.0 | `3D models created with Meshy for HORMUZ – CC BY 4.0` |
| KayKit Character Animations 1.2 | CC0 1.0 | See `assets/models/animation-v1/SOURCE.md` and the bundled license |
| Natural Earth coastline data | Public domain | See `docs/MAP_SOURCES.md` |
| three.js | MIT | Copyright and SPDX notice are preserved in the vendor files |
| meshoptimizer decoder | MIT | Copyright notice is preserved in the vendor file |

The production game's ElevenLabs free-plan sound effects are intentionally **not included**
in this source release. `assets/data/rts-audio.json` uses an empty event list, so the public
build runs with a silent fallback. Contributors may add audio only when its redistribution
and commercial-use terms are compatible with this repository and are documented here.
