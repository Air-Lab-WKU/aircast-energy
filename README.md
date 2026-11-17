# AirCast-Energy: Probabilistic Electricity Demand Forecasts

An experimental research product from the **AI Research Laboratory (AIR Lab)** at the **Disaster Science Operations Center (DSOC)**, Western Kentucky University.

Website: [https://air-lab-wku.github.io/aircast-energy/](https://air-lab-wku.github.io/aircast-energy/)

## Overview
AirCast-Energy provides probabilistic electricity-demand forecasts across 29 balancing authorities in the contiguous United States for days 1 to 14 (medium-range) and weeks 1 to 2.

- **Lead times:** Days 1–14 daily peak and daily energy; weeks 1–2 weekly peak and weekly energy.
- **Probabilities:** Calibrated exceedance chances for top-10%, top-5%, and top-1% seasonal demand thresholds.
- **Model:** `operational_v1` multi-stage ensemble demand stack trained on FERC Form 714 and calibrated with EIA-930 and ECMWF IFS ensemble forecasts.

## People
- **Dr. Manmeet Singh** – Lab Director & Principal Investigator, Assistant Professor, Department of Earth, Environmental & Atmospheric Sciences, Western Kentucky University
- **Somnath Luitel** – Graduate Researcher & Lead Developer, AIR Lab, Western Kentucky University

## Data Sources & Attribution
- **ECMWF open data** (CC BY 4.0): Contains modified ECMWF open data.
- **Copernicus Climate Change Service (C3S)**: ERA5 and ERA5T reanalysis.
- **U.S. Energy Information Administration (EIA)**: EIA-930 hourly grid monitor data.
- **Federal Energy Regulatory Commission (FERC)**: Form 714 demand data.
- **NOAA**: nClimGrid gridded temperatures and Climate Prediction Center indices.
- **HIFLD / Oak Ridge, Los Alamos & Idaho National Laboratories with NGA HSIP**: Balancing-authority outlines.

## Disclaimer
Experimental research product. Not for operational dispatch decisions. For grid operations, consult the forecasts of the responsible balancing authority or regional transmission operator.
