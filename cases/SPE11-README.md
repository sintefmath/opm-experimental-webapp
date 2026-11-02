# SPE11 example decks

Decks for the three cases of the 11th SPE Comparative Solution Project (SPE11, CO2 storage):
A (2D, lab scale, 2.8 m x 1.2 m, 5 days), B (2D, 8.4 km x 1.2 km, 1000 years) and
C (3D, 8.4 km x 5 km x 1.2 km, 1000 years). They were generated with
[pyopmspe11](https://github.com/OPM/pyopmspe11) (MIT licence, see `LICENSE-pyopmspe11.txt`)
from the configs in this folder, which follow pyopmspe11's `benchmark/` setups with coarser
corner-point grids so that they run in a browser:

| Case | Grid | Cells | Injection | Run time (node, 4 threads) |
|------|------|-------|-----------|----------------------------|
| SPE11A | 56 x 1 x 34 | 1904 | 2 wells | about 2 min |
| SPE11B | 86 x 1 x 31 | 2666 | SOURCE terms (as in the benchmark) | about 10 s |
| SPE11C | 44 x 22 x 24 | 23232 | 2 horizontal wells | about 1.7 min |

SPE11B uses SOURCE terms because wells in its 1 m thick 2D section force very small time steps
(about 3 minutes instead of 10 seconds); the 3D view only shows wells, not sources.

The `flow` line of each config holds the recommended flow options; the web app fills them in as
"Extra flow arguments" when the example is loaded. Regenerate the decks with `./generate.sh`.
