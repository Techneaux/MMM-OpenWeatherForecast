# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MMM-OpenWeatherForecast is a MagicMirror² weather module that displays current, hourly, and daily forecast data. Supports two weather providers:
- **OpenWeather** (default) - Requires API key
- **Free** - Uses weather.gov + sunrise-sunset.org + EPA (US only, no API key)

## Commands

- `npm ci` - Install dependencies
- `node --run lint` - Run ESLint on JS, CSS, and Markdown files
- `node --run lint:fix` - Auto-fix linting issues
- `node --run test` - Runs linting (alias for lint)

## Architecture

### Core Files

- **MMM-OpenWeatherForecast.js** - Frontend MagicMirror² module. Registers the module, manages configuration/defaults, processes weather data for display, handles animated icons (Skycons), and renders via Nunjucks template.

- **node_helper.js** - Node.js backend that fetches weather data. Supports two providers:
  - `openweather`: Fetches from OpenWeather One Call API 3.0
  - `free`: Fetches from weather.gov, sunrise-sunset.org, and EPA APIs, then transforms to OpenWeather format

- **mmm-openweather-forecast.njk** - Nunjucks template for rendering the weather display. Logic-minimal; displays pre-formatted data from `getTemplateData()`.

- **skycons.js** - Animated weather icons library (Dark Sky's Skycons, forked for color customization).

### Data Flow

**OpenWeather Provider:**
1. Frontend sends `OPENWEATHER_FORECAST_GET` socket notification with config
2. node_helper fetches from OpenWeather One Call API 3.0
3. node_helper returns data via `OPENWEATHER_FORECAST_DATA` notification

**Free Provider:**
1. Frontend sends `OPENWEATHER_FORECAST_GET` socket notification with config
2. node_helper fetches in parallel from:
   - weather.gov `/points` and `/gridpoints` endpoints
   - sunrise-sunset.org API
   - EPA UV index API (if zipcode provided)
   - weather.gov `/alerts` endpoint
3. node_helper transforms data to OpenWeather format
4. node_helper returns data via `OPENWEATHER_FORECAST_DATA` notification

**Both providers (continued):**
1. Frontend's `processWeatherData()` formats raw API data for template
2. Template renders via `getTemplateData()` which provides formatted forecast and icon paths

### Key Configuration

Required: `latitude`, `longitude`

For OpenWeather provider: `apikey` (required)
For Free provider: `zipcode` (optional, for UV index)

Provider selection: `weatherProvider: "openweather"` or `weatherProvider: "free"`

The module supports multiple icon sets (1c, 1m, 2c, 2m, etc. in `icons/` directory) and two forecast layouts: "tiled" and "table".

### Broadcast

The module emits `OPENWEATHER_FORECAST_WEATHER_UPDATE` notification with the weather data (in OpenWeather format) for other modules to consume.
