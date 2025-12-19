/* eslint-disable camelcase */
/* eslint-disable max-lines-per-function */
/* eslint-disable max-lines */
/**
 ********************************
 *
 *Node Helper for MMM-OpenWeatherForecast.
 *
 *This helper is responsible for the data pull from weather APIs.
 *Supports two providers:
 *  - "openweather": OpenWeather One Call API 3.0 (requires API key)
 *  - "free": weather.gov + sunrise-sunset.org + EPA (no API key required, US only)
 *
 *At a minimum the Latitude and Longitude parameters must be provided.
 *For OpenWeather, an API key is also required.
 *For the free provider, a ZIP code is required for UV index data.
 *
 ********************************
 */

const Log = require("logger");
const NodeHelper = require("node_helper");
const moment = require("moment");
const path = require("path");
const fs = require("fs");

module.exports = NodeHelper.create({

  start () {
    Log.log(`Starting node_helper for: ${this.name}`);
    this.gridPointCache = {}; // Cache grid coordinates by lat,lon
  },

  // Unit conversion helpers
  convertTemp (celsius, targetUnits) {
    if (celsius === null) {
      return null;
    }
    if (targetUnits === "imperial") {
      return celsius * 9 / 5 + 32;
    }
    if (targetUnits === "standard") {
      return celsius + 273.15;
    }
    return celsius; // metric
  },

  convertSpeed (kmh, targetUnits) {
    if (kmh === null) {
      return null;
    }
    if (targetUnits === "imperial") {
      return kmh * 0.621371; // km/h to mph
    }
    // metric and standard both use m/s
    return kmh * 0.277778;
  },

  // Cache file path for daily forecast values
  getCacheFilePath () {
    return path.join(__dirname, ".cache", "forecast-cache.json");
  },

  // Read cache from file
  async readCache () {
    const cacheFile = this.getCacheFilePath();
    try {
      const data = await fs.promises.readFile(cacheFile, "utf8");
      return JSON.parse(data);
    } catch (error) {
      // File doesn't exist or is corrupt - return empty cache
      const isFileMissing = error.code === "ENOENT";
      const isJsonParseError = error instanceof SyntaxError;
      if (!isFileMissing && !isJsonParseError) {
        Log.warn(`[MMM-OpenWeatherForecast] Error reading cache: ${error.message}`);
      }
    }
    // Return empty cache structure
    return {version: 1, location: "", days: {}};
  },

  // Write cache to file with 7-day limit
  async writeCache (cacheData) {
    const cacheFile = this.getCacheFilePath();
    const cacheDir = path.dirname(cacheFile);

    try {
      // Ensure .cache directory exists
      await fs.promises.mkdir(cacheDir, {recursive: true});

      // Prune old entries (keep only 7 days)
      const prunedData = this.pruneCache(cacheData);

      await fs.promises.writeFile(cacheFile, JSON.stringify(prunedData, null, 2));
    } catch (error) {
      Log.warn(`[MMM-OpenWeatherForecast] Error writing cache: ${error.message}`);
    }
  },

  // Prune cache to keep only last 7 days
  pruneCache (cacheData) {
    const days = cacheData.days || {};
    const now = new Date();
    const sevenDaysAgo = new Date(now);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const cutoffDate = moment(sevenDaysAgo).format("YYYY-MM-DD");

    const prunedDays = {};
    // YYYY-MM-DD format is lexicographically sortable, so string comparison works for date ordering
    for (const [dateKey, values] of Object.entries(days)) {
      if (dateKey >= cutoffDate) {
        prunedDays[dateKey] = values;
      }
    }

    return {...cacheData, days: prunedDays};
  },

  // Merge daily forecast with cached values
  // eslint-disable-next-line max-params
  mergeDailyWithCache (daily, cacheData, latitude, longitude) {
    const locationKey = `${parseFloat(latitude).toFixed(2)},${parseFloat(longitude).toFixed(2)}`;

    // Clear cache if location changed significantly
    let cache = cacheData;
    if (cache.location && cache.location !== locationKey) {
      Log.info("[MMM-OpenWeatherForecast] Location changed, clearing forecast cache");
      cache = {version: 1, location: locationKey, days: {}};
    }
    cache.location = locationKey;

    const mergedDaily = daily.map((day, dayIndex) => {
      // Get date key in local timezone (YYYY-MM-DD format)
      const dateKey = moment(day.dt * 1000).format("YYYY-MM-DD");
      const cached = cache.days[dateKey] || {};

      /*
       * Day 0 (today): Use max/min merge to preserve earlier forecasts when API period shrinks
       * Future days: Use current API values to honor forecast revisions (cache as fallback only)
       */
      const isToday = dayIndex === 0;
      const merged = this.mergeValuesForDay(day, cached, isToday);

      // Update cache entry (cache values for potential fallback use)
      cache.days[dateKey] = {
        maxTemp: merged.temp.max,
        minTemp: merged.temp.min,
        maxWind: merged.wind,
        maxGust: merged.gust,
        maxPop: merged.pop,
        maxRain: merged.rain,
        maxSnow: merged.snow,
        maxUvi: merged.uvi,
        lastUpdated: Math.floor(Date.now() / 1000)
      };

      // Return merged day object
      return {
        ...day,
        temp: merged.temp,
        wind_speed: merged.wind,
        wind_gust: merged.gust,
        pop: merged.pop,
        rain: merged.rain,
        snow: merged.snow,
        uvi: merged.uvi
      };
    });

    return [mergedDaily, cache];
  },

  /*
   * Helper: merge values for a single day based on whether it's today or a future day
   * Today: Use max/min merge to preserve earlier forecasts when API period shrinks
   * Future: Use current API values, cache as fallback only when null (honors forecast revisions)
   */
  mergeValuesForDay (day, cached, isToday) {
    return {
      temp: this.mergeTempForDay(day.temp, cached, isToday),
      wind: isToday
        ? this.mergeMax(cached.maxWind, day.wind_speed)
        : day.wind_speed ?? cached.maxWind,
      gust: isToday
        ? this.mergeMax(cached.maxGust, day.wind_gust)
        : day.wind_gust ?? cached.maxGust,
      pop: isToday
        ? this.mergeMax(cached.maxPop, day.pop)
        : day.pop ?? cached.maxPop,
      rain: isToday
        ? this.mergeMax(cached.maxRain, day.rain)
        : day.rain ?? cached.maxRain,
      snow: isToday
        ? this.mergeMax(cached.maxSnow, day.snow)
        : day.snow ?? cached.maxSnow,
      uvi: isToday
        ? this.mergeMax(cached.maxUvi, day.uvi)
        : day.uvi ?? cached.maxUvi
    };
  },

  // Helper: merge temperature values for a day
  mergeTempForDay (temp, cached, isToday) {
    return {
      day: temp?.day,
      min: isToday
        ? this.mergeMin(cached.minTemp, temp?.min)
        : temp?.min ?? cached.minTemp,
      max: isToday
        ? this.mergeMax(cached.maxTemp, temp?.max)
        : temp?.max ?? cached.maxTemp,
      night: temp?.night,
      eve: temp?.eve,
      morn: temp?.morn
    };
  },

  // Helper: merge by keeping max value (handles null, undefined, NaN)
  mergeMax (cached, current) {
    if (cached === null || typeof cached === "undefined" || Number.isNaN(cached)) {
      return current;
    }
    if (current === null || typeof current === "undefined" || Number.isNaN(current)) {
      return cached;
    }
    return Math.max(cached, current);
  },

  // Helper: merge by keeping min value (handles null, undefined, NaN)
  mergeMin (cached, current) {
    if (cached === null || typeof cached === "undefined" || Number.isNaN(cached)) {
      return current;
    }
    if (current === null || typeof current === "undefined" || Number.isNaN(current)) {
      return cached;
    }
    return Math.min(cached, current);
  },

  async socketNotificationReceived (notification, payload) {
    if (notification === "OPENWEATHER_FORECAST_GET") {
      if (payload.latitude === null || payload.latitude === "" || payload.longitude === null || payload.longitude === "") {
        Log.error(`[MMM-OpenWeatherForecast] ${moment().format("D-MMM-YY HH:mm")} ** ERROR ** Latitude and/or longitude not provided.`);
        return;
      }

      if (payload.weatherProvider === "free") {
        await this.fetchFreeProviderData(payload);
      } else {
        await this.fetchOpenWeatherData(payload);
      }
    } else if (notification === "CONFIG") {
      this.config = payload;
    }
  },

  // OpenWeather provider (existing functionality)
  async fetchOpenWeatherData (payload) {
    if (payload.apikey === null || payload.apikey === "") {
      Log.error(`[MMM-OpenWeatherForecast] ${moment().format("D-MMM-YY HH:mm")} ** ERROR ** No API key configured. Get an API key at https://openweathermap.org/`);
      return;
    }

    const url = `${payload.apiBaseURL
    }lat=${payload.latitude
    }&lon=${payload.longitude
    }&exclude=minutely` +
    `&appid=${payload.apikey
    }&units=${payload.units
    }&lang=${payload.language}`;

    if (typeof this.config !== "undefined") {
      Log.debug(`[MMM-OpenWeatherForecast] Fetching OpenWeather url: ${url}`);
    }

    try {
      const response = await fetch(url);

      if (response.status !== 200) {
        Log.error(`[MMM-OpenWeatherForecast] OpenWeather API error: ${response.status} ${response.statusText}`);
        return;
      }

      const data = await response.json();

      if (typeof data !== "undefined") {
        data.instanceId = payload.instanceId;
        this.sendSocketNotification("OPENWEATHER_FORECAST_DATA", data);
      }
    } catch (error) {
      Log.error(`[MMM-OpenWeatherForecast] ${moment().format("D-MMM-YY HH:mm")} ** ERROR ** ${error}\n${error.stack}`);
    }
  },

  // Free provider (weather.gov + sunrise-sunset.org + EPA)
  async fetchFreeProviderData (payload) {
    const {latitude, longitude, zipcode, units, instanceId} = payload;

    try {
      Log.info("[MMM-OpenWeatherForecast] Fetching from free providers (weather.gov, sunrise-sunset.org, EPA)");

      // Fetch all data in parallel
      const [gridData, sunData, uvData, alertsData] = await Promise.all([
        this.fetchWeatherGovData(latitude, longitude),
        this.fetchSunriseSunsetData(latitude, longitude),
        zipcode
          ? this.fetchEpaUvData(zipcode)
          : Promise.resolve(null),
        this.fetchWeatherGovAlerts(latitude, longitude)
      ]);

      if (!gridData) {
        Log.error("[MMM-OpenWeatherForecast] Failed to fetch weather.gov data");
        return;
      }

      // Transform to OpenWeather format
      const data = this.transformFreeDataToOpenWeatherFormat(gridData, sunData, uvData, alertsData, units, latitude, longitude);

      // Merge daily forecast with cached values for full-day max/min
      const cache = await this.readCache();
      const [mergedDaily, updatedCache] = this.mergeDailyWithCache(data.daily, cache, latitude, longitude);
      data.daily = mergedDaily;
      await this.writeCache(updatedCache);

      data.instanceId = instanceId;
      this.sendSocketNotification("OPENWEATHER_FORECAST_DATA", data);
    } catch (error) {
      Log.error(`[MMM-OpenWeatherForecast] ${moment().format("D-MMM-YY HH:mm")} ** ERROR ** ${error}\n${error.stack}`);
    }
  },

  // Fetch weather.gov grid data
  async fetchWeatherGovData (latitude, longitude) {
    const cacheKey = `${latitude},${longitude}`;
    const userAgent = "MMM-OpenWeatherForecast MagicMirror Module";

    try {
      // Get grid coordinates (cached)
      let gridInfo = this.gridPointCache[cacheKey];
      if (!gridInfo) {
        const pointsUrl = `https://api.weather.gov/points/${latitude},${longitude}`;
        const pointsResponse = await fetch(pointsUrl, {
          headers: {"User-Agent": userAgent}
        });

        if (pointsResponse.status !== 200) {
          Log.error(`[MMM-OpenWeatherForecast] weather.gov points API error: ${pointsResponse.status}`);
          return null;
        }

        const pointsData = await pointsResponse.json();
        gridInfo = {
          office: pointsData.properties.gridId,
          gridX: pointsData.properties.gridX,
          gridY: pointsData.properties.gridY
        };
        this.gridPointCache[cacheKey] = gridInfo;
        Log.info(`[MMM-OpenWeatherForecast] Cached grid info: ${gridInfo.office}/${gridInfo.gridX},${gridInfo.gridY}`);
      }

      // Fetch raw gridpoint data
      const gridUrl = `https://api.weather.gov/gridpoints/${gridInfo.office}/${gridInfo.gridX},${gridInfo.gridY}`;
      const gridResponse = await fetch(gridUrl, {
        headers: {"User-Agent": userAgent}
      });

      if (gridResponse.status !== 200) {
        Log.error(`[MMM-OpenWeatherForecast] weather.gov gridpoints API error: ${gridResponse.status}`);
        return null;
      }

      return await gridResponse.json();
    } catch (error) {
      Log.error(`[MMM-OpenWeatherForecast] weather.gov fetch error: ${error}`);
      return null;
    }
  },

  // Fetch sunrise/sunset data
  async fetchSunriseSunsetData (latitude, longitude) {
    try {
      const url = `https://api.sunrise-sunset.org/json?lat=${latitude}&lng=${longitude}&formatted=0`;
      const response = await fetch(url);

      if (response.status !== 200) {
        Log.error(`[MMM-OpenWeatherForecast] sunrise-sunset.org API error: ${response.status}`);
        return null;
      }

      const data = await response.json();
      return data.status === "OK"
        ? data.results
        : null;
    } catch (error) {
      Log.error(`[MMM-OpenWeatherForecast] sunrise-sunset.org fetch error: ${error}`);
      return null;
    }
  },

  // Fetch EPA UV index data
  async fetchEpaUvData (zipcode) {
    try {
      const url = `https://data.epa.gov/efservice/getEnvirofactsUVHOURLY/ZIP/${zipcode}/JSON`;
      const response = await fetch(url);

      if (response.status !== 200) {
        Log.error(`[MMM-OpenWeatherForecast] EPA UV API error: ${response.status}`);
        return null;
      }

      const data = await response.json();
      return Array.isArray(data) && data.length > 0
        ? data
        : null;
    } catch (error) {
      Log.error(`[MMM-OpenWeatherForecast] EPA UV fetch error: ${error}`);
      return null;
    }
  },

  // Fetch weather.gov alerts
  async fetchWeatherGovAlerts (latitude, longitude) {
    try {
      const url = `https://api.weather.gov/alerts/active?point=${latitude},${longitude}`;
      const response = await fetch(url, {
        headers: {"User-Agent": "MMM-OpenWeatherForecast MagicMirror Module"}
      });

      if (response.status !== 200) {
        Log.error(`[MMM-OpenWeatherForecast] weather.gov alerts API error: ${response.status}`);
        return null;
      }

      return await response.json();
    } catch (error) {
      Log.error(`[MMM-OpenWeatherForecast] weather.gov alerts fetch error: ${error}`);
      return null;
    }
  },

  // Transform free provider data to OpenWeather format
  // eslint-disable-next-line max-params
  transformFreeDataToOpenWeatherFormat (gridData, sunData, uvData, alertsData, units, latitude, longitude) {
    const props = gridData.properties;
    const now = new Date();

    // Helper to get current value from a weather.gov time series
    const getCurrentValue = (series) => {
      if (!series || !series.values || series.values.length === 0) {
        return null;
      }
      const nowMs = now.getTime();
      for (const item of series.values) {
        const [start, duration] = this.parseValidTime(item.validTime);
        const end = new Date(start.getTime() + duration);
        if (nowMs >= start.getTime() && nowMs < end.getTime()) {
          return item.value;
        }
      }
      // If no current match, return first value
      return series.values[0].value;
    };

    // Get current UV index from EPA data
    const getCurrentUv = () => {
      if (!uvData) {
        return 0;
      }
      const currentHour = now.getHours();
      for (const item of uvData) {
        if (item.ORDER === currentHour || item.HOUR === currentHour) {
          return item.UV_VALUE || 0;
        }
      }
      // Return max UV for day if current hour not found
      return Math.max(...uvData.map((item) => item.UV_VALUE || 0));
    };

    // Build current conditions
    const current = {
      dt: Math.floor(now.getTime() / 1000),
      temp: this.convertTemp(getCurrentValue(props.temperature), units),
      feels_like: this.convertTemp(getCurrentValue(props.apparentTemperature), units),
      humidity: getCurrentValue(props.relativeHumidity),
      dew_point: this.convertTemp(getCurrentValue(props.dewpoint), units),
      pressure: getCurrentValue(props.pressure) / 100, // Convert Pa to hPa
      visibility: getCurrentValue(props.visibility), // meters
      wind_speed: this.convertSpeed(getCurrentValue(props.windSpeed), units),
      wind_gust: this.convertSpeed(getCurrentValue(props.windGust), units),
      wind_deg: getCurrentValue(props.windDirection),
      uvi: getCurrentUv(),
      clouds: getCurrentValue(props.skyCover),
      sunrise: sunData
        ? Math.floor(new Date(sunData.sunrise).getTime() / 1000)
        : null,
      sunset: sunData
        ? Math.floor(new Date(sunData.sunset).getTime() / 1000)
        : null,
      weather: this.getWeatherCondition(props, sunData)
    };

    // Build daily forecast
    const daily = this.buildDailyForecast(props, sunData, uvData, units);

    // Build hourly forecast
    const hourly = this.buildHourlyForecast(props, sunData, units);

    // Build alerts
    const alerts = this.buildAlerts(alertsData);

    return {
      lat: latitude,
      lon: longitude,
      timezone: props.timeZone || "America/Chicago",
      timezone_offset: 0,
      current,
      daily,
      hourly,
      alerts
    };
  },

  // Parse weather.gov validTime format: "2024-12-17T18:00:00+00:00/PT3H"
  parseValidTime (validTime) {
    const parts = validTime.split("/");
    const start = new Date(parts[0]);
    let durationMs = 3600000; // default 1 hour

    if (parts[1]) {
      const durationStr = parts[1];
      const match = durationStr.match(/PT?(?<num>\d+)(?<unit>[HMD])/iu);
      if (match) {
        const value = parseInt(match.groups.num, 10);
        const unit = match.groups.unit.toUpperCase();
        if (unit === "H") {
          durationMs = value * 3600000;
        } else if (unit === "M") {
          durationMs = value * 60000;
        } else if (unit === "D") {
          durationMs = value * 86400000;
        }
      }
    }

    return [start, durationMs];
  },

  // Get weather condition at a specific time from weather.gov weather series
  getWeatherAtTime (props, targetTime) {
    if (!props.weather || !props.weather.values) {
      return null;
    }

    const targetMs = targetTime.getTime();

    for (const item of props.weather.values) {
      const [start, duration] = this.parseValidTime(item.validTime);
      const end = new Date(start.getTime() + duration);
      if (targetMs >= start.getTime() && targetMs < end.getTime()) {
        // weather.gov weather.value is an array of conditions
        if (item.value && item.value.length > 0) {
          return item.value[0];
        }
      }
    }
    return null;
  },

  // Get weather condition from weather.gov data
  getWeatherCondition (props, sunData = null) {
    const now = new Date();
    const condition = this.getWeatherAtTime(props, now);

    const sunrise = sunData
      ? Math.floor(new Date(sunData.sunrise).getTime() / 1000)
      : null;
    const sunset = sunData
      ? Math.floor(new Date(sunData.sunset).getTime() / 1000)
      : null;
    const timestamp = Math.floor(now.getTime() / 1000);

    // Map weather.gov conditions to OpenWeather-like format
    const mapping = this.mapWeatherCondition(condition, timestamp, sunrise, sunset);
    return [mapping];
  },

  // Map weather.gov condition to OpenWeather format
  // eslint-disable-next-line complexity, max-params
  mapWeatherCondition (condition, timestamp = null, sunrise = null, sunset = null) {
    // Determine day/night based on sunrise/sunset if available
    const checkTime = timestamp
      ? new Date(timestamp * 1000)
      : new Date();

    const isDay = sunrise && sunset
      ? checkTime >= new Date(sunrise * 1000) && checkTime < new Date(sunset * 1000)
      : checkTime.getHours() >= 6 && checkTime.getHours() < 18;

    const dayNight = isDay
      ? "d"
      : "n";

    if (!condition) {
      return {id: 800, main: "Clear", description: "clear sky", icon: `01${dayNight}`};
    }

    const weather = condition.weather || "";
    const coverage = condition.coverage || "";
    const intensity = condition.intensity || "";

    // Simplified mapping - replace underscores with spaces for proper formatting
    const desc = `${coverage} ${intensity} ${weather}`
      .replace(/_/gu, " ")
      .toLowerCase()
      .trim()
      .replace(/\s+/gu, " ");

    if (weather.includes("thunder") || weather.includes("storm")) {
      return {id: 200, main: "Thunderstorm", description: desc, icon: `11${dayNight}`};
    }
    if (weather.includes("snow") || weather.includes("blizzard")) {
      return {id: 600, main: "Snow", description: desc, icon: `13${dayNight}`};
    }
    if (weather.includes("rain") || weather.includes("drizzle") || weather.includes("showers")) {
      if (intensity === "light") {
        return {id: 500, main: "Rain", description: desc, icon: `10${dayNight}`};
      }
      return {id: 501, main: "Rain", description: desc, icon: `10${dayNight}`};
    }
    if (weather.includes("fog") || weather.includes("mist") || weather.includes("haze")) {
      return {id: 741, main: "Fog", description: desc, icon: `50${dayNight}`};
    }
    if (weather.includes("cloud") || coverage.includes("overcast") || coverage.includes("mostly")) {
      if (coverage.includes("few") || coverage.includes("partly")) {
        return {id: 801, main: "Clouds", description: desc, icon: `02${dayNight}`};
      }
      if (coverage.includes("scattered")) {
        return {id: 802, main: "Clouds", description: desc, icon: `03${dayNight}`};
      }
      return {id: 804, main: "Clouds", description: desc, icon: `04${dayNight}`};
    }
    if (weather.includes("wind")) {
      return {id: 771, main: "Wind", description: desc, icon: `50${dayNight}`};
    }

    // Default to clear
    return {id: 800, main: "Clear", description: "clear sky", icon: `01${dayNight}`};
  },

  // Build daily forecast from weather.gov data
  // eslint-disable-next-line max-params
  buildDailyForecast (props, sunData, uvData, units) {
    const daily = [];
    const now = new Date();

    // Get base sunrise/sunset timestamps (we'll adjust by day offset)
    const baseSunrise = sunData
      ? Math.floor(new Date(sunData.sunrise).getTime() / 1000)
      : null;
    const baseSunset = sunData
      ? Math.floor(new Date(sunData.sunset).getTime() / 1000)
      : null;

    // Calculate max UV for today from EPA data (only available for current day)
    const todayMaxUv = uvData && uvData.length > 0
      ? Math.max(...uvData.map((item) => item.UV_VALUE || 0))
      : 0;

    /*
     * Get values for a specific day from a time series
     * useOverlap: if true, include periods that overlap with target day at all
     *             if false, only include periods that start on target day
     */
    const getValuesForDay = (series, dayOffset, useOverlap = false) => {
      if (!series || !series.values) {
        return [];
      }
      const targetDate = new Date(now);
      targetDate.setDate(targetDate.getDate() + dayOffset);

      if (useOverlap) {
        // Include periods that overlap with target day at all
        const dayStart = new Date(targetDate);
        dayStart.setHours(0, 0, 0, 0);
        const dayStartMs = dayStart.getTime();
        const dayEndMs = dayStartMs + 86400000; // 24 hours in ms

        return series.values.filter((item) => {
          const [start, duration] = this.parseValidTime(item.validTime);
          const startMs = start.getTime();
          const endMs = startMs + duration;
          return startMs < dayEndMs && endMs > dayStartMs;
        }).map((item) => item.value);
      }

      // Match local target day against UTC date from weather.gov timestamps
      const targetDay = moment(targetDate).format("YYYY-MM-DD");
      return series.values.filter((item) => {
        const [start] = this.parseValidTime(item.validTime);
        return moment(start)
          .utc()
          .format("YYYY-MM-DD") === targetDay;
      }).map((item) => item.value);
    };

    // Build 7 days of forecast
    for (let i = 0; i < 7; i++) {
      const date = new Date(now);
      date.setDate(date.getDate() + i);
      date.setHours(12, 0, 0, 0); // Noon for daily icon

      /*
       * Filter nulls first, then check length to avoid Math.max/min on empty arrays
       * Temperature: maxTemp uses same day, minTemp uses next day (meteorological standard: "tonight's low")
       */
      const validMaxTemps = getValuesForDay(props.maxTemperature, i).filter((v) => v !== null);
      let validMinTemps = getValuesForDay(props.minTemperature, i + 1).filter((v) => v !== null);
      if (validMinTemps.length === 0) {
        // Fallback for last day when i+1 has no data
        validMinTemps = getValuesForDay(props.minTemperature, i).filter((v) => v !== null);
      }
      // Precip/Wind/POP: use overlap logic to include evening periods in "today"
      const validWindSpeeds = getValuesForDay(props.windSpeed, i, true).filter((v) => v !== null);
      const validWindGusts = getValuesForDay(props.windGust, i, true).filter((v) => v !== null);
      const validPops = getValuesForDay(props.probabilityOfPrecipitation, i, true).filter((v) => v !== null);
      const rain = getValuesForDay(props.quantitativePrecipitation, i, true);
      const snow = getValuesForDay(props.snowfallAmount, i, true);

      const maxTemp = validMaxTemps.length > 0
        ? Math.max(...validMaxTemps)
        : null;
      const minTemp = validMinTemps.length > 0
        ? Math.min(...validMinTemps)
        : null;
      const maxWind = validWindSpeeds.length > 0
        ? Math.max(...validWindSpeeds)
        : null;
      const maxGust = validWindGusts.length > 0
        ? Math.max(...validWindGusts)
        : null;
      const maxPop = validPops.length > 0
        ? Math.max(...validPops)
        : 0;
      const totalRain = rain.length > 0
        ? rain.reduce((a, b) => (a || 0) + (b || 0), 0)
        : 0;
      const totalSnow = snow.length > 0
        ? snow.reduce((a, b) => (a || 0) + (b || 0), 0)
        : 0;

      // Get weather condition for noon of this day
      const condition = this.getWeatherAtTime(props, date);
      const timestamp = Math.floor(date.getTime() / 1000);

      // Adjust sunrise/sunset by day offset (86400 seconds per day)
      const adjustedSunrise = baseSunrise
        ? baseSunrise + i * 86400
        : null;
      const adjustedSunset = baseSunset
        ? baseSunset + i * 86400
        : null;

      daily.push({
        dt: timestamp,
        sunrise: adjustedSunrise,
        sunset: adjustedSunset,
        temp: {
          day: this.convertTemp(maxTemp, units),
          min: this.convertTemp(minTemp, units),
          max: this.convertTemp(maxTemp, units),
          night: this.convertTemp(minTemp, units),
          eve: this.convertTemp(maxTemp, units),
          morn: this.convertTemp(minTemp, units)
        },
        feels_like: {
          day: this.convertTemp(maxTemp, units),
          night: this.convertTemp(minTemp, units),
          eve: this.convertTemp(maxTemp, units),
          morn: this.convertTemp(minTemp, units)
        },
        humidity: (() => {
          const humidityValues = getValuesForDay(props.relativeHumidity, i, true).filter((v) => v !== null);
          if (humidityValues.length === 0) {
            return 50;
          }
          return humidityValues.reduce((sum, v) => sum + v, 0) / humidityValues.length;
        })(),
        wind_speed: this.convertSpeed(maxWind, units),
        wind_gust: this.convertSpeed(maxGust, units),
        wind_deg: getValuesForDay(props.windDirection, i)[0] || 0,
        pop: maxPop / 100, // OpenWeather uses 0-1
        rain: totalRain,
        snow: totalSnow,
        weather: [this.mapWeatherCondition(condition, timestamp, adjustedSunrise, adjustedSunset)],
        uvi: i === 0
          ? todayMaxUv
          : 0 // EPA data only available for current day
      });
    }

    return daily;
  },

  // Build hourly forecast from weather.gov data
  buildHourlyForecast (props, sunData, units) {
    const hourly = [];
    const now = new Date();

    // Get sunrise/sunset timestamps (use today's times, close enough for day/night)
    const sunrise = sunData
      ? Math.floor(new Date(sunData.sunrise).getTime() / 1000)
      : null;
    const sunset = sunData
      ? Math.floor(new Date(sunData.sunset).getTime() / 1000)
      : null;

    // Get values by hour from time series
    const getValueAtHour = (series, targetTime) => {
      if (!series || !series.values) {
        return null;
      }
      const targetMs = targetTime.getTime();

      for (const item of series.values) {
        const [start, duration] = this.parseValidTime(item.validTime);
        const end = new Date(start.getTime() + duration);
        if (targetMs >= start.getTime() && targetMs < end.getTime()) {
          return item.value;
        }
      }
      return null;
    };

    // Build 48 hours of forecast
    for (let i = 0; i < 48; i++) {
      const hourTime = new Date(now);
      hourTime.setMinutes(0, 0, 0);
      hourTime.setHours(hourTime.getHours() + i);

      const temp = getValueAtHour(props.temperature, hourTime);
      const pop = getValueAtHour(props.probabilityOfPrecipitation, hourTime);
      const wind = getValueAtHour(props.windSpeed, hourTime);
      const gust = getValueAtHour(props.windGust, hourTime);
      const humidity = getValueAtHour(props.relativeHumidity, hourTime);
      const pressure = getValueAtHour(props.pressure, hourTime);
      const windDir = getValueAtHour(props.windDirection, hourTime);

      // Get weather condition for this hour
      const condition = this.getWeatherAtTime(props, hourTime);
      const timestamp = Math.floor(hourTime.getTime() / 1000);

      // For day/night calculation on future days, adjust sunrise/sunset by day offset
      const dayOffset = Math.floor(i / 24);
      const adjustedSunrise = sunrise
        ? sunrise + dayOffset * 86400
        : null;
      const adjustedSunset = sunset
        ? sunset + dayOffset * 86400
        : null;

      hourly.push({
        dt: timestamp,
        temp: this.convertTemp(temp, units),
        feels_like: this.convertTemp(getValueAtHour(props.apparentTemperature, hourTime), units),
        humidity: humidity || 50,
        pressure: (pressure || 101300) / 100, // Convert Pa to hPa
        wind_speed: this.convertSpeed(wind, units),
        wind_gust: this.convertSpeed(gust, units),
        wind_deg: windDir || 0,
        pop: (pop || 0) / 100,
        weather: [this.mapWeatherCondition(condition, timestamp, adjustedSunrise, adjustedSunset)]
      });
    }

    return hourly;
  },

  // Build alerts from weather.gov data
  buildAlerts (alertsData) {
    if (!alertsData || !alertsData.features || alertsData.features.length === 0) {
      return [];
    }

    return alertsData.features.map((feature) => {
      const props = feature.properties;
      return {
        sender_name: props.senderName || "National Weather Service",
        event: props.event || "Weather Alert",
        start: props.onset
          ? Math.floor(new Date(props.onset).getTime() / 1000)
          : null,
        end: props.ends
          ? Math.floor(new Date(props.ends).getTime() / 1000)
          : null,
        description: props.description || "",
        tags: [props.severity, props.urgency, props.certainty].filter(Boolean)
      };
    });
  }
});
