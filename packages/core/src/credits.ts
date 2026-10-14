// Attribution shown on every route image, in embed footers and in /about.

export const MAP_CREDITS = [
  '© SCS Software (not affiliated)',
  'truckermudgeon/maps',
  'MapLibre',
  'PMTiles',
] as const;

export const MAP_CREDIT_LINE = MAP_CREDITS.join(' · ');

export const ABOUT_TEXT = [
  'PlasmaTrack is a non-commercial job tracker for Euro Truck Simulator 2 and American Truck Simulator.',
  'ETS2 and ATS are always kept separate.',
  '',
  '**Map credits**',
  '• Map data © SCS Software. PlasmaTrack is not affiliated with or endorsed by SCS Software.',
  '• Basemap tiles generated with truckermudgeon/maps (GPL-3.0).',
  '• Rendered with MapLibre Native; tiles stored as PMTiles.',
  '',
  'PlasmaTrack Bot is licensed under the PolyForm Noncommercial License 1.0.0.',
].join('\n');
