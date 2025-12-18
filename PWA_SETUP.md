# Progressive Web App (PWA) Setup

QR Secure Share is configured as a Progressive Web App with a **network-first** caching strategy.

## Features

### 🌐 Network-First Strategy
All assets use a network-first approach:
- **Try network first** with a timeout (5-10 seconds depending on asset type)
- **Fall back to cache** if network is unavailable or slow
- **Update cache** when network response succeeds
- This ensures users always get the latest version when possible

### 📱 Installation
Users can install the app on:
- **Android**: "Add to Home Screen" via browser menu
- **iOS**: Share → Add to Home Screen
- **Desktop**: Install button in browser address bar (Chrome, Edge)

Once installed, the app:
- Works offline with cached assets
- Loads faster from cache on subsequent visits
- Can be updated automatically when new versions are available

### 🔄 Automatic Updates
The app automatically:
1. Checks for service worker updates on every page load
2. Notifies users when updates are available
3. Allows users to update immediately or defer
4. Updates in the background if skipped

### 📊 Caching Strategy

#### Pages (HTML)
- **Strategy**: Network First
- **Timeout**: 5 seconds
- **Cache Duration**: 7 days
- **Max Entries**: 50

#### Scripts & CSS (JS/CSS)
- **Strategy**: Network First
- **Timeout**: 8 seconds
- **Cache Duration**: 7 days
- **Max Entries**: 100

#### Workers & WASM
- **Strategy**: Network First
- **Timeout**: 8-10 seconds
- **Cache Duration**: 7 days
- **Max Entries**: 20

#### Fonts
- **Strategy**: Network First
- **Timeout**: 5 seconds
- **Cache Duration**: 30 days (Google Fonts CSS), 1 year (Font Files)
- **Max Entries**: 20

#### Images
- **Strategy**: Network First
- **Timeout**: 5 seconds
- **Cache Duration**: 7 days
- **Max Entries**: 100

## Development

### Building for PWA
The PWA plugin is only enabled in production builds:

```bash
npm run build
npm run preview
```

In development (`npm run dev`), service workers are disabled for easier debugging.

### Testing Locally
Use the test deployment script to test PWA functionality:

```bash
./scripts/test-deploy.sh
```

This serves the app with proper caching headers.

### DevTools Inspection
In Chrome DevTools:
1. **Application tab** → Service Workers: Check registration status
2. **Cache Storage**: View cached assets
3. **Manifest**: Verify manifest.json is loaded
4. **Console**: Check for registration messages

## Offline Behavior

### When Offline
- The app shows a notification banner at the bottom
- All cached assets continue to work
- Offline QR file transfer still works (no network needed)
- Text QR generation works normally

### When Network Returns
- Notification disappears automatically
- App continues to function normally
- New assets are fetched when needed

## Update Notifications

When a new version is deployed:
1. Service worker detects the update
2. A dialog appears asking to update
3. User can choose "Update Now" or "Later"
4. Selecting "Update" reloads the app with new version

## Cache Management

The service worker automatically:
- Cleans up outdated caches
- Respects expiration times (max age seconds)
- Limits cache sizes (max entries)
- Removes old entries when limits are reached

## Security Considerations

- All cache operations happen locally on the device
- No data is synced to external services
- Offline functionality doesn't compromise security
- Network-first strategy ensures security updates are applied

## Performance Impact

### Improvements
- **Faster loads**: Cached assets serve instantly on repeat visits
- **Battery savings**: Reduced network requests
- **Better UX**: Graceful degradation when offline
- **Reduced bandwidth**: Uses cache when possible

### Trade-offs
- Network request timeout adds slight latency (5-10 seconds)
- Cache storage uses device storage
- Users see cache updates after reload

## Troubleshooting

### Service Worker not updating
1. Clear all site data (DevTools → Storage → Clear site data)
2. Delete app from home screen and reinstall
3. Check browser logs for errors

### App showing old version
1. Hard refresh (Cmd+Shift+R on Mac, Ctrl+Shift+R on Windows)
2. Clear cache in settings
3. Uninstall and reinstall app

### Large cache size
1. Clear site data periodically
2. Adjust `maxEntries` in cache configuration
3. Reduce `maxAgeSeconds` for frequently changing assets

## Configuration

All PWA settings are in `vite.config.ts` under the `VitePWA` plugin configuration:
- Manifest settings (icons, colors, display)
- Workbox configuration (caching strategies, timeouts)
- DevTools behavior
