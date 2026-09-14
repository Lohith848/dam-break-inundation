# Reference Papers

Papers and documents referenced during the design of the simulation and
hydrology pipeline.

| Document | Tracked in Git? | Source |
| --- | --- | --- |
| `NRLD 2023-1_final.pdf` — National Register of Large Dams (2023), Central Water Commission, India (~90 MB) | **No** — excluded via `.gitignore` to keep the repository light | Download from [India-WRIS](https://india-wris.nrsc.gov.in/) or the [CWC publications portal](https://cwc.gov.in/); search for "National Register of Large Dams 2023" |
| `Pankaj Sharma_assignmnet_Dams of South India.pdf` (~0.7 MB) | Yes | Course assignment on South Indian dams; used as context for the Mettur Dam case study |

## Why the big PDF is not committed

At ~90 MB, the NRLD report approaches GitHub's 100 MB per-file limit and
would dominate clone sizes for all contributors. It is referenced only as
background reading — the dam parameters actually used by the simulator
(crest length, storage capacity, breach coefficients, etc.) are captured in
`datasets/dam/mettur_parameters.csv` and documented in
`docs/HYDRODYNAMICS.md`.
