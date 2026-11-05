// ============================================================
// services/spotify.js — On-Device Spotify Metadata Extractor
//
// Resolves { id, title, artist, artists, durationMs, coverUrl }
// directly from the phone or browser.
//
// How it works:
//   1. Native Mobile (iOS / Android): Fetches Spotify's embed page
//      (https://open.spotify.com/embed/track/<id>) directly from the
//      phone and parses the __NEXT_DATA__ JSON for full metadata.
//   2. Web Browser / Fallback: Calls Spotify's official CORS-enabled
//      oEmbed API (https://open.spotify.com/oembed?url=...) or falls
//      back to tify-api if needed.
// ============================================================

import { Platform } from 'react-native';

const TRACK_ID_PATTERN = /track[/:]([A-Za-z0-9]{22})/;

/**
 * Extract the 22-character Spotify track ID from any track URL or URI.
 */
export async function extractTrackId(input) {
  if (!input || typeof input !== 'string') return null;
  const url = input.trim();

  const direct = url.match(TRACK_ID_PATTERN);
  if (direct) return direct[1];

  // Expand short links (spotify.link / spoti.fi) on native devices
  if (Platform.OS !== 'web' && /^https?:\/\/(spotify\.link|spoti\.fi)\//i.test(url)) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      const fromUrl = res.url?.match(TRACK_ID_PATTERN);
      if (fromUrl) return fromUrl[1];
      const html = await res.text();
      const fromBody = html.match(/open\.spotify\.com\/track\/([A-Za-z0-9]{22})/);
      if (fromBody) return fromBody[1];
    } catch {
      // Fall through
    }
  }

  return null;
}

/**
 * Parse Spotify's public embed page HTML (__NEXT_DATA__) on native devices.
 * Returns { id, title, artist, artists, durationMs, coverUrl }.
 */
async function fetchFromEmbedPage(trackId) {
  const res = await fetch(`https://open.spotify.com/embed/track/${trackId}`, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  if (!res.ok) throw new Error(`Spotify embed returned HTTP ${res.status}`);

  const html = await res.text();
  const match = html.match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/
  );
  if (!match) throw new Error('No __NEXT_DATA__ found on embed page');

  const entity = JSON.parse(match[1])?.props?.pageProps?.state?.data?.entity;
  const title = entity?.name || entity?.title;
  if (!title) throw new Error('Track title missing in embed JSON');

  const artists = (entity.artists || []).map((a) => a.name).filter(Boolean);
  const images = entity.visualIdentity?.image || [];
  const biggestImage = images.reduce(
    (best, img) => (!best || (img.maxWidth || 0) > (best.maxWidth || 0) ? img : best),
    null
  );

  return {
    id: trackId,
    title,
    artists,
    artist: artists.join(', '),
    durationMs: entity.duration || null,
    coverUrl: biggestImage?.url || null,
  };
}

/**
 * Fetch from Spotify's public oEmbed endpoint (works in both Web browsers
 * with CORS and on Mobile).
 */
async function fetchFromOembed(trackId) {
  const trackUrl = `https://open.spotify.com/track/${trackId}`;
  const res = await fetch(
    `https://open.spotify.com/oembed?url=${encodeURIComponent(trackUrl)}`
  );
  if (!res.ok) throw new Error(`Spotify oEmbed returned HTTP ${res.status}`);

  const data = await res.json();
  if (!data.title) throw new Error('No title in oEmbed response');

  return {
    id: trackId,
    title: data.title,
    artists: [],
    artist: '',
    durationMs: null,
    coverUrl: data.thumbnail_url || null,
  };
}

/**
 * Resolve Spotify metadata directly on-device.
 * On native mobile, uses the rich embed page first (title + artist + duration + cover)
 * and falls back to oEmbed. On web, uses CORS-friendly oEmbed first.
 */
export async function resolveSpotifyTrackOnDevice(spotifyUrl) {
  const trackId = await extractTrackId(spotifyUrl);
  if (!trackId) {
    throw new Error(
      'That does not look like a Spotify track link (playlists/albums are not supported yet).'
    );
  }

  if (Platform.OS !== 'web') {
    try {
      return await fetchFromEmbedPage(trackId);
    } catch {
      return await fetchFromOembed(trackId);
    }
  }

  // In a web browser, open.spotify.com/oembed allows CORS (*) natively!
  return await fetchFromOembed(trackId);
}
