/** Trusted-host POI data exports. Values grant no account or disclosure authority. */
const {
  prepareRailgunPoiSubmission,
  normalizeRailgunPoiSubmission,
  inspectRailgunPoiResponse,
} = require('@freedom/railgun-kohaku-adapter/host/poi');
module.exports = {
  prepareRailgunPoiSubmission,
  normalizeRailgunPoiSubmission,
  inspectRailgunPoiResponse,
};
