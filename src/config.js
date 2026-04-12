// Environment config for Tracely extension.
//
// Environment is detected automatically:
//   - Development : unpacked extension (no `update_url` in manifest)
//   - Production  : published via Chrome Web Store (has `update_url`)
//
// To update URLs for a new environment, edit only this file.
(function () {
    const IS_PRODUCTION = !!chrome.runtime.getManifest().update_url;
  
    const DEVELOPMENT = {
      API_BASE_URL: 'http://localhost:3000',
      WEB_APP_CANDIDATE_BASE_URLS: [
        'http://localhost:8080',
        'http://127.0.0.1:8080',
      ],
      WEB_APP_URL_PATTERNS: [
        'http://localhost:8080/*',
        'http://127.0.0.1:8080/*',
      ],
      WEB_APP_ORIGINS: new Set([
        'http://localhost:8080',
        'http://127.0.0.1:8080',
      ]),
    };
  
    const PRODUCTION = {
      API_BASE_URL: 'https://app.tracely.uk',
      WEB_APP_CANDIDATE_BASE_URLS: [
        'https://app.tracely.uk',
      ],
      WEB_APP_URL_PATTERNS: [
        'https://app.tracely.uk/*',
      ],
      WEB_APP_ORIGINS: new Set([
        'https://app.tracely.uk',
      ]),
    };
  
    self.GD_CONFIG = IS_PRODUCTION ? PRODUCTION : DEVELOPMENT;
  })();
  