# BridgeIntent logo integration

The supplied 1254 × 1254 PNG is the canonical BridgeIntent mark. Its composition combines a CVE notice, a connected evidence graph, and a verified Ethereum receipt. The dominant visual language is deep navy linework with blue, violet, and mint accents on a white background.

Implementation guidance:

- Preserve the complete square artwork without cropping in hero placements (`object-fit: contain`).
- Use compact square crops only for small brand and empty-state marks, where the full artwork remains recognizable.
- Keep the original white background and use multiply blending on the light interface so the asset integrates with the existing paper-like surfaces.
- Serve the file from `frontend/public/bridgeintent-mark.png` so the Vercel frontend deployment contains the asset at `/bridgeintent-mark.png`.
