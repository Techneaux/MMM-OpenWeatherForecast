 

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
const moment = require("moment-timezone");

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

      // First: fetch gridData (this caches grid coordinates needed for forecast)
      const gridData = await this.fetchWeatherGovData(latitude, longitude);

      if (!gridData) {
        Log.error("[MMM-OpenWeatherForecast] Failed to fetch weather.gov data");
        return;
      }

      // Now fetch forecast and other data in parallel (grid info is cached)
      const [forecastData, hourlyForecastData, sunData, uvData, alertsData] = await Promise.all([
        this.fetchWeatherGovForecast(latitude, longitude, units),
        this.fetchWeatherGovHourlyForecast(latitude, longitude),
        this.fetchSunriseSunsetData(latitude, longitude),
        zipcode
          ? this.fetchEpaUvData(zipcode)
          : Promise.resolve(null),
        this.fetchWeatherGovAlerts(latitude, longitude)
      ]);

      // Transform to OpenWeather format
      const data = this.transformFreeDataToOpenWeatherFormat(gridData, forecastData, hourlyForecastData, sunData, uvData, alertsData, units, latitude, longitude);

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

  /**
   * Extract hour (0-23) from EPA UV data item
   * EPA DATE_TIME format: "DEC/20/2025 03 AM" or similar
   * Note: EPA UV times are in local time for the zipcode location
   * @param {Object} item - EPA UV data item
   * @returns {number} Hour in 24-hour format (0-23)
   */
  getUvHour (item) {
    if (item.DATE_TIME) {
      const match = item.DATE_TIME.match(/(?<hour>\d{1,2})\s*(?<period>AM|PM)/iu);
      if (match) {
        let hour = parseInt(match.groups.hour, 10);
        const isPM = match.groups.period.toUpperCase() === "PM";
        if (isPM && hour !== 12) {
          hour += 12;
        }
        if (!isPM && hour === 12) {
          hour = 0;
        }
        return hour;
      }
    }

    /*
     * Fallback: assume ORDER 1 = 3 AM, so hour = ORDER + 2
     * This covers 3 AM to 11 PM (typical UV forecast range)
     */
    return (item.ORDER || 0) + 2;
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

  // Fetch weather.gov forecast (12-hour periods with high/low temps)
  async fetchWeatherGovForecast (latitude, longitude, units) {
    const cacheKey = `${latitude},${longitude}`;
    const gridInfo = this.gridPointCache[cacheKey];

    if (!gridInfo) {
      Log.warn("[MMM-OpenWeatherForecast] Grid info not cached, cannot fetch forecast");
      return null;
    }

    // weather.gov supports "us" and "si"; both "metric" and "standard" map to "si"
    const unitsParam = units === "imperial"
      ? "us"
      : "si";
    const cacheBuster = Date.now();
    const url = `https://api.weather.gov/gridpoints/${gridInfo.office}/${gridInfo.gridX},${gridInfo.gridY}/forecast?units=${unitsParam}&_=${cacheBuster}`;

    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "MMM-OpenWeatherForecast MagicMirror Module",
          "Cache-Control": "no-cache"
        }
      });

      if (response.status !== 200) {
        Log.error(`[MMM-OpenWeatherForecast] weather.gov forecast API error: ${response.status}`);
        return null;
      }

      return await response.json();
    } catch (error) {
      Log.error(`[MMM-OpenWeatherForecast] weather.gov forecast fetch error: ${error}`);
      return null;
    }
  },

  // Fetch weather.gov hourly forecast (168 hours with conditions)
  async fetchWeatherGovHourlyForecast (latitude, longitude) {
    const cacheKey = `${latitude},${longitude}`;
    const gridInfo = this.gridPointCache[cacheKey];

    if (!gridInfo) {
      Log.warn("[MMM-OpenWeatherForecast] Grid info not cached, cannot fetch hourly forecast");
      return null;
    }

    const url = `https://api.weather.gov/gridpoints/${gridInfo.office}/${gridInfo.gridX},${gridInfo.gridY}/forecast/hourly`;

    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "MMM-OpenWeatherForecast MagicMirror Module",
          "Cache-Control": "no-cache"
        }
      });

      if (response.status !== 200) {
        Log.error(`[MMM-OpenWeatherForecast] weather.gov hourly forecast API error: ${response.status}`);
        return null;
      }

      return await response.json();
    } catch (error) {
      Log.error(`[MMM-OpenWeatherForecast] weather.gov hourly forecast fetch error: ${error}`);
      return null;
    }
  },

  /**
   * Get current hour in a specific timezone
   * @param {string} timezone - IANA timezone (e.g., "America/Chicago")
   * @returns {number} Current hour (0-23) in that timezone
   */
  getLocalHour (timezone) {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      hour12: false
    });
    return parseInt(formatter.format(new Date()), 10);
  },

  // Transform free provider data to OpenWeather format
   
  transformFreeDataToOpenWeatherFormat (gridData, forecastData, hourlyForecastData, sunData, uvData, alertsData, units, latitude, longitude) {
    const props = gridData.properties;
    const now = new Date();
    const timezone = props.timeZone || "America/Chicago";
    const hourlyPeriods = hourlyForecastData?.properties?.periods || [];

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
        if (this.getUvHour(item) === currentHour) {
          return item.UV_VALUE || 0;
        }
      }
      // Return max UV for day if current hour not found
      return Math.max(...uvData.map((item) => item.UV_VALUE || 0));
    };

    // Get current weather condition from hourly forecast (first period)
    const currentHourlyPeriod = hourlyPeriods[0];
    const parsedCurrentCondition = currentHourlyPeriod
      ? this.parseShortForecast(currentHourlyPeriod.shortForecast, currentHourlyPeriod.isDaytime)
      : null;
    const currentWeatherCondition = parsedCurrentCondition
      ? [parsedCurrentCondition]
      : this.getWeatherCondition(props, sunData);

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
      weather: currentWeatherCondition
    };

    // Build daily forecast using forecast periods for high/low temps
    const daily = this.buildDailyForecast(props, forecastData, sunData, uvData, units, timezone);

    // Build hourly forecast
    const hourly = this.buildHourlyForecast(props, hourlyPeriods, sunData, units);

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

  /**
   * Parse shortForecast text from /forecast API into weather condition object
   * @param {string} shortForecast - Text like "Sunny", "Mostly Cloudy", "Chance Light Snow"
   * @param {boolean} isDaytime - Whether it's daytime (from forecast period)
   * @returns {Object} Weather condition object matching OpenWeather format
   */
   
  parseShortForecast (shortForecast, isDaytime) {
    if (!shortForecast) {
      return null;
    }

    const text = shortForecast.toLowerCase();
    const dayNight = isDaytime
      ? "d"
      : "n";

    // Check for precipitation types first (most specific)
    if (text.includes("thunder") || text.includes("storm")) {
      return {id: 200, main: "Thunderstorm", description: shortForecast.toLowerCase(), icon: `11${dayNight}`};
    }
    if (text.includes("snow") || text.includes("blizzard") || text.includes("flurries")) {
      return {id: 600, main: "Snow", description: shortForecast.toLowerCase(), icon: `13${dayNight}`};
    }
    if (text.includes("sleet") || text.includes("freezing") || text.includes("ice")) {
      return {id: 611, main: "Sleet", description: shortForecast.toLowerCase(), icon: `13${dayNight}`};
    }
    if (text.includes("rain") || text.includes("showers") || text.includes("drizzle")) {
      return {id: 500, main: "Rain", description: shortForecast.toLowerCase(), icon: `10${dayNight}`};
    }

    // Atmospheric conditions
    if (text.includes("fog") || text.includes("mist") || text.includes("haze") || text.includes("smoke")) {
      return {id: 741, main: "Fog", description: shortForecast.toLowerCase(), icon: `50${dayNight}`};
    }

    // Cloud cover
    if (text.includes("overcast") || text.includes("cloudy")) {
      if (text.includes("partly") || text.includes("mostly clear") || text.includes("mostly sunny")) {
        return {id: 801, main: "Clouds", description: shortForecast.toLowerCase(), icon: `02${dayNight}`};
      }
      if (text.includes("mostly cloudy")) {
        return {id: 803, main: "Clouds", description: shortForecast.toLowerCase(), icon: `04${dayNight}`};
      }
      return {id: 804, main: "Clouds", description: shortForecast.toLowerCase(), icon: `04${dayNight}`};
    }

    // Partially clear conditions (sunny/clear side phrasing)
    if (text.includes("partly sunny") || text.includes("mostly sunny") || text.includes("mostly clear")) {
      return {id: 801, main: "Clouds", description: shortForecast.toLowerCase(), icon: `02${dayNight}`};
    }

    // Clear conditions
    if (text.includes("sunny") || text.includes("clear")) {
      return {id: 800, main: "Clear", description: shortForecast.toLowerCase(), icon: `01${dayNight}`};
    }

    // Wind
    if (text.includes("wind") || text.includes("breezy") || text.includes("blustery")) {
      return {id: 771, main: "Wind", description: shortForecast.toLowerCase(), icon: `50${dayNight}`};
    }

    // Default to clear if no match
    return {id: 800, main: "Clear", description: shortForecast.toLowerCase(), icon: `01${dayNight}`};
  },

  /**
   * Find the hourly forecast period that contains the given time
   * @param {Array} periods - Hourly forecast periods from /forecast/hourly API
   * @param {Date} targetTime - The time to find a period for
   * @returns {Object|null} The matching forecast period or null
   */
  findHourlyPeriod (periods, targetTime) {
    if (!periods || periods.length === 0) {
      return null;
    }

    const targetMs = targetTime.getTime();

    for (const period of periods) {
      const start = new Date(period.startTime).getTime();
      const end = new Date(period.endTime).getTime();

      if (targetMs >= start && targetMs < end) {
        return period;
      }
    }

    return null;
  },

  /**
   * Get values for a specific day from a weather.gov time series
   * @param {Object} series - The time series data (e.g., props.windSpeed)
   * @param {Date} baseDate - The base date (usually now)
   * @param {number} dayOffset - Days from baseDate (0 = today)
   * @param {boolean} useOverlap - If true, include periods that overlap with target day
   * @param {boolean} futureOnly - If true, only include periods that haven't ended yet (for day 0)
   * @param {string} timezone - IANA timezone name for calculating day boundaries
   * @returns {Array} Array of values for that day
   */
  getValuesForDay (series, baseDate, dayOffset, useOverlap = false, futureOnly = false, timezone = null) {
    if (!series || !series.values) {
      return [];
    }
    const targetDate = new Date(baseDate);
    targetDate.setDate(targetDate.getDate() + dayOffset);

    if (useOverlap) {
      // Calculate day boundaries in location's timezone
      const tz = timezone || "America/Chicago";
      const dayStart = moment(targetDate).tz(tz)
        .startOf("day");
      const dayStartMs = dayStart.valueOf();
      const dayEndMs = dayStartMs + 86400000; // 24 hours in ms
      const nowMs = Date.now();

      return series.values.filter((item) => {
        const [start, duration] = this.parseValidTime(item.validTime);
        const startMs = start.getTime();
        const endMs = startMs + duration;

        // Must overlap with target day
        const overlapsDay = startMs < dayEndMs && endMs > dayStartMs;

        // If futureOnly, period must not have ended yet
        if (futureOnly && dayOffset === 0) {
          return overlapsDay && endMs > nowMs;
        }
        return overlapsDay;
      }).map((item) => item.value);
    }

    // Match target day against weather.gov timestamps (both in local time)
    const targetDay = moment(targetDate).format("YYYY-MM-DD");
    return series.values.filter((item) => {
      const [start] = this.parseValidTime(item.validTime);
      return moment(start).format("YYYY-MM-DD") === targetDay;
    }).map((item) => item.value);
  },

  /**
   * Extract day/night period temperatures from forecast data
   * @param {Array} periods - Forecast periods from /forecast API
   * @param {number} periodIdx - Current index in periods array
   * @returns {Object} { dayPeriod, nightPeriod, newPeriodIdx }
   */
  extractForecastPeriods (periods, periodIdx) {
    let dayPeriod = null;
    let nightPeriod = null;
    let idx = periodIdx;

    // Check for day period (if available)
    if (idx < periods.length && periods[idx].isDaytime) {
      dayPeriod = periods[idx];
      idx++;
    }

    // Check for night period (if available)
    if (idx < periods.length && !periods[idx].isDaytime) {
      nightPeriod = periods[idx];
      idx++;
    }

    return {dayPeriod, nightPeriod, newPeriodIdx: idx};
  },

  /**
   * Calculate daily aggregates (wind, precip, etc.) from gridpoints data
   * @param {Object} props - Gridpoints properties
   * @param {Date} baseDate - Base date for calculations
   * @param {number} dayOffset - Days from baseDate
   * @param {string} timezone - IANA timezone name for calculating day boundaries
   * @returns {Object} Aggregated values for the day
   */
  calculateDailyAggregates (props, baseDate, dayOffset, timezone) {
    const tz = timezone || props.timeZone || "America/Chicago";
    // For today (dayOffset 0), only include current and future periods
    const futureOnly = dayOffset === 0;

    const validWindSpeeds = this.getValuesForDay(props.windSpeed, baseDate, dayOffset, true, futureOnly, tz).filter((v) => v !== null);
    const validWindGusts = this.getValuesForDay(props.windGust, baseDate, dayOffset, true, futureOnly, tz).filter((v) => v !== null);
    const validPops = this.getValuesForDay(props.probabilityOfPrecipitation, baseDate, dayOffset, true, futureOnly, tz).filter((v) => v !== null);
    const rain = this.getValuesForDay(props.quantitativePrecipitation, baseDate, dayOffset, true, futureOnly, tz);
    const snow = this.getValuesForDay(props.snowfallAmount, baseDate, dayOffset, true, futureOnly, tz);
    const humidityValues = this.getValuesForDay(props.relativeHumidity, baseDate, dayOffset, true, futureOnly, tz).filter((v) => v !== null);

    return {
      maxWind: validWindSpeeds.length > 0
        ? Math.max(...validWindSpeeds)
        : null,
      maxGust: validWindGusts.length > 0
        ? Math.max(...validWindGusts)
        : null,
      maxPop: validPops.length > 0
        ? Math.max(...validPops)
        : 0,
      totalRain: rain.length > 0
        ? rain.reduce((a, b) => (a || 0) + (b || 0), 0)
        : 0,
      totalSnow: snow.length > 0
        ? snow.reduce((a, b) => (a || 0) + (b || 0), 0)
        : 0,
      avgHumidity: humidityValues.length > 0
        ? humidityValues.reduce((sum, v) => sum + v, 0) / humidityValues.length
        : 50,
      windDeg: this.getValuesForDay(props.windDirection, baseDate, dayOffset)[0] || 0
    };
  },

  // Build daily forecast using /forecast periods for high/low temps
   
  buildDailyForecast (props, forecastData, sunData, uvData, units, timezone) {
    const daily = [];
    const now = new Date();
    const tz = timezone || props.timeZone || "America/Chicago";
    const currentHour = this.getLocalHour(tz);

    // Get base sunrise/sunset timestamps (we'll adjust by day offset)
    const baseSunrise = sunData
      ? Math.floor(new Date(sunData.sunrise).getTime() / 1000)
      : null;
    const baseSunset = sunData
      ? Math.floor(new Date(sunData.sunset).getTime() / 1000)
      : null;

    // Calculate max UV for current and remaining hours today from EPA data (only available for current day)
    const todayMaxUv = uvData && uvData.length > 0
      ? Math.max(...uvData
        .filter((item) => this.getUvHour(item) >= currentHour)
        .map((item) => item.UV_VALUE || 0), 0)
      : 0;

    // Get forecast periods (already in correct units from API)
    const periods = forecastData?.properties?.periods || [];
    let periodIdx = 0;

    // DEBUG: Log first 3 periods
    Log.info(`[MMM-OpenWeatherForecast] DEBUG: First 3 periods: ${JSON.stringify(periods.slice(0, 3).map(p => ({name: p.name, isDaytime: p.isDaytime, temp: p.temperature})))}`);

    // Build 7 days of forecast
    for (let i = 0; i < 7; i++) {
      const date = new Date(now);
      date.setDate(date.getDate() + i);
      date.setHours(12, 0, 0, 0); // Noon for daily icon

      // Extract day/night periods for temps
      const {dayPeriod, nightPeriod, newPeriodIdx} = this.extractForecastPeriods(periods, periodIdx);
      periodIdx = newPeriodIdx;

      // Temps already in target units from /forecast?units=us|si
      const highTemp = dayPeriod?.temperature ?? null;
      const lowTemp = nightPeriod?.temperature ?? null;

      // DEBUG: Log day 0 extraction
      if (i === 0) {
        Log.info(`[MMM-OpenWeatherForecast] DEBUG Day 0: dayPeriod=${dayPeriod?.name || 'null'}, nightPeriod=${nightPeriod?.name || 'null'}, highTemp=${highTemp}, lowTemp=${lowTemp}`);
      }

      // Get aggregates from gridpoints data
      const agg = this.calculateDailyAggregates(props, now, i, tz);

      // Get weather condition from forecast period (prefer day, fallback to night)
      const forecastPeriod = dayPeriod || nightPeriod;
      const parsedDailyCondition = forecastPeriod
        ? this.parseShortForecast(forecastPeriod.shortForecast, forecastPeriod.isDaytime)
        : null;
      const weatherCondition = parsedDailyCondition || this.mapWeatherCondition(null, null, null, null);

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
          day: highTemp,
          min: lowTemp,
          max: highTemp,
          night: lowTemp,
          eve: highTemp,
          morn: lowTemp
        },
        feels_like: {
          day: highTemp,
          night: lowTemp,
          eve: highTemp,
          morn: lowTemp
        },
        humidity: agg.avgHumidity,
        wind_speed: this.convertSpeed(agg.maxWind, units),
        wind_gust: this.convertSpeed(agg.maxGust, units),
        wind_deg: agg.windDeg,
        pop: agg.maxPop / 100, // OpenWeather uses 0-1
        rain: agg.totalRain,
        snow: agg.totalSnow,
        weather: [weatherCondition],
        uvi: i === 0
          ? todayMaxUv
          : 0 // EPA data only available for current day
      });
    }

    return daily;
  },

  // Build hourly forecast from weather.gov data
  buildHourlyForecast (props, hourlyPeriods, sunData, units) {
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

      // Get weather condition from hourly forecast periods
      const hourlyPeriod = this.findHourlyPeriod(hourlyPeriods, hourTime);
      const timestamp = Math.floor(hourTime.getTime() / 1000);

      // For day/night calculation on future days, adjust sunrise/sunset by day offset
      const dayOffset = Math.floor(i / 24);
      const adjustedSunrise = sunrise
        ? sunrise + dayOffset * 86400
        : null;
      const adjustedSunset = sunset
        ? sunset + dayOffset * 86400
        : null;

      // Use hourly forecast period for weather condition, fallback to gridpoints data
      const parsedHourlyCondition = hourlyPeriod
        ? this.parseShortForecast(hourlyPeriod.shortForecast, hourlyPeriod.isDaytime)
        : null;
      const weatherCondition = parsedHourlyCondition ||
        this.mapWeatherCondition(this.getWeatherAtTime(props, hourTime), timestamp, adjustedSunrise, adjustedSunset);

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
        weather: [weatherCondition]
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
