# Contribution Guide — Engineering Standards & Testing

## 1. Core Contribution Principles
This is a production digital twin for the Smart India Hackathon (SIH26161). All contributions must uphold strict scientific integrity:
1. **Never fabricate simulation data**: All water levels, flood areas, velocities, and arrival times must be derived from the numerical solver or GeoTIFF DEMs.
2. **Preserve existing APIs**: Backend endpoint paths, request bodies, and response envelopes are frozen to maintain stability across all client consumers.
3. **Keep 3D models lightweight**: Optimize new GLB assets (Draco compression, polygon reduction, texture size under 2048×2048) to uphold the 60 FPS desktop / 30 FPS iGPU target.

## 2. Pull Request Workflow
1. Create a feature branch: `git checkout -b feature/dam-mesh-optimization`
2. Implement targeted modifications adhering strictly to minimal code footprint.
3. Run verification tests:
   ```bash
   # Frontend build verification
   cd frontend
   npm run build

   # Backend test suite (all 54 tests must pass)
   cd ../backend
   python -m pytest tests/
   ```
4. Verify responsive layout and camera constraints in browser.
5. Submit PR with detailed before/after validation notes.
