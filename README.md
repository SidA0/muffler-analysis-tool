# Muffler Analysis Tool

A browser-based tool for turning FFT sound pressure spectra into an RPM versus dBC curve, a 3D RPM–frequency–level plot, and a per-RPM contribution ranking in 300 Hz ranges. Measurements stay in the browser; the app has no upload server.

Live page: https://sida0.github.io/muffler-analysis-tool/

## Run locally

1. Install Node.js 20 or newer.
2. In this folder, run `npm install` and `npm run dev`.
3. Open the local URL printed by Vite.

## Use

Upload `.xlsx`, `.xls`, `.csv`, or `.tsv`. Select the worksheet, layout, header row, and columns. The supported layouts are:

- One row per RPM and frequency: `RPM | Frequency (Hz) | SPL (dB)`.
- Frequency rows with RPM column headings.
- RPM rows with frequency column headings.

Choose whether source levels are unweighted dB SPL (the app applies C weighting) or already C weighted dBC. Click **Analyze data**. The 3D chart is a top surface: RPM and frequency are its horizontal axes; height and color show the highest measured C weighted level at each RPM–frequency coordinate. Repeated readings at a coordinate use the maximum for this surface. Missing coordinates remain gaps. **Surface smoothing** offers Off, Light, Medium, and Strong Gaussian filtering across neighboring RPM and frequency bins. Smoothing changes the displayed surface only; the hover shows the measured worst case, and totals, contributions, attenuation calculations, and exports still use measured values. Click an RPM chart point or choose an RPM to inspect its leading 300 Hz ranges. A single tone is flagged if it has at least 8% of total energy and is at least 6 dB above the next strongest measured bin in a range containing at least three bins. **Export results CSV** includes each RPM's total, bracket level and energy share, and any flagged tone.

## Attenuation curve

Paste two columns (frequency in Hz and attenuation in dB) or import an Excel/CSV curve file. The app linearly interpolates attenuation between points, subtracts it from each spectral bin, and sums the attenuated bins to show the new dBC at each RPM. Outside the supplied frequency range you can choose 0 dB attenuation or hold the nearest endpoint. The before/after CSV exports one row per RPM.

## Optimize frequencies

After analyzing a workbook, open **Optimize frequencies**. Select an RPM, a target dBC, a 5–20% safety margin, and a run length. The margin is a percentage of linear sound pressure: the design target is `target dBC + 20 log10(1 − margin/100)`. The **Start from the attenuation curve already applied** option searches for additional reductions on top of the current curve.

All run lengths recommend cuts in the same 300 Hz brackets. Short, balanced, and long runs use increasing refinement time. The progress bar reports the iterative solve, and **Stop** cancels it. The solver minimizes squared attenuation with a penalty for abrupt changes between neighboring brackets, subject to the design target and a 60 dB cut limit per bracket. It returns a frequency cut table and CSV, and flags any standout single tone in the starting spectrum. **Apply to RPM graph** combines the recommendation with the selected baseline and recalculates all RPMs. This is a mathematical target plan; actual achievable attenuation depends on the physical system.

## Ansys Harmonic Acoustics

Choose an RPM and export either a pressure spectrum CSV or a Mechanical APDL `.inp` command snippet. The CSV contains unweighted SPL, RMS Pa, and peak Pa by frequency. The `.inp` file creates a `FREQ` table of peak pressure amplitudes and applies it with `D,ALL,PRES,%FFT_P%` to the nodal component named in the interface. Create that component on the intended acoustic fluid boundary in Ansys Mechanical, then insert the snippet in the Harmonic Acoustics analysis as a command object. Check its scope, frequency sweep, units, and solution before interpreting the result.

SPL spectra contain magnitude only. The export assumes zero phase at every frequency, and it does not recover the source's spatial distribution. A prescribed pressure boundary is a Dirichlet condition; reflected sound pressure at that boundary is not represented. When the imported source is already dBC, the export reverses C weighting bin by bin to estimate unweighted pressure. A fully physical excitation requires calibrated unweighted amplitude and phase or another suitable source definition.

Ansys references: [Mechanical Harmonic Acoustics Pressure object](https://ansyshelp.ansys.com/public/Views/Secured/corp/v252/en/mech_acous/mech_acous_pressure.html), [APDL `D` command and tabular input](https://ansyshelp.ansys.com/public/Views/Secured/corp/v251/en/ans_cmd/Hlp_C_D.html), [APDL pressure excitation behavior](https://ansyshelp.ansys.com/public/Views/Secured/corp/v251/en/ans_acous/acous_excit_src.html), and [acoustic RMS reference pressure](https://ansyshelp.ansys.com/public/views/secured/corp/v252/en/mech_obj/ds_Results_and_Result_Tools_o_r.html).

The total is an energy sum of the available bins, not an arithmetic average of dB values. Repeated measurements of the same RPM and frequency are energy averaged first. Input levels must be calibrated sound pressure levels; raw FFT magnitudes cannot be converted to dBC without calibration. The ranking describes contributions to the measured sum, not a causal diagnosis of the physical source.

## Publish to GitHub Pages

Run `npm run build`, copy the contents of `dist/` into `docs/`, then commit and push. GitHub Pages serves `docs/` from the `main` branch. The build uses relative asset URLs, so it works in the project subdirectory.
