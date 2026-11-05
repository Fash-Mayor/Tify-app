// ============================================================
// services/audioResolver.js — On-Device Audio Stream Resolver
//
// Why this exists (Phase 2 / Option 3):
//   YouTube blocks shared cloud datacenter IPs (like Render's free tier)
//   with HTTP 429 / "Sign in to confirm you're not a bot".
//   Your phone, however, runs on a residential Wi-Fi or mobile carrier IP!
//
//   By querying YouTube Music's Innertube API directly from the phone:
//     1. Search `music.youtube.com/youtubei/v1/search` for "<Artist> - <Title> audio"
//        to get the matching videoId AND a fresh session `visitorData` token.
//     2. Query `youtube.com/youtubei/v1/player` using the `VISIONOS` / `IOS`
//        mobile client context (which serves direct `itag=140` `.m4a` AAC streams
//        without needing a JavaScript challenge solver runtime).
//
//   Result on mobile:
//     - 0 Render cold starts
//     - 0 datacenter IP blocks
//     - 0 backend RAM usage
//     - Real-time byte progress via FileSystem.createDownloadResumable
// ============================================================

const VISIONOS_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

const IOS_UA =
  'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)';

/**
 * Step 1: Search YouTube Music Innertube API for the track and extract
 * both candidate videoIds and a session `visitorData` token.
 */
async function searchYouTubeInnertube(query) {
  const res = await fetch('https://music.youtube.com/youtubei/v1/search?prettyPrint=false', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': VISIONOS_UA,
    },
    body: JSON.stringify({
      context: {
        client: {
          clientName: 'WEB_REMIX',
          clientVersion: '1.20250101.01.00',
          hl: 'en',
          gl: 'US',
        },
      },
      query,
    }),
  });

  if (!res.ok) {
    throw new Error(`YouTube search returned HTTP ${res.status}`);
  }

  const data = await res.json();
  const visitorData = data?.responseContext?.visitorData || undefined;
  const rawJson = JSON.stringify(data);

  // Extract unique 11-character videoIds in order of appearance
  const matches = [...rawJson.matchAll(/"videoId":"([a-zA-Z0-9_-]{11})"/g)].map(
    (m) => m[1]
  );
  const videoIds = [...new Set(matches)];

  if (!videoIds.length) {
    throw new Error(`No YouTube audio matches found for "${query}".`);
  }

  return { videoIds, visitorData };
}

/**
 * Step 2: Request the direct `.m4a` (`itag=140`) stream URL from YouTube's
 * Innertube `/player` endpoint using VISIONOS (primary) and IOS (fallback).
 */
async function fetchDirectM4aStream(videoId, visitorData, targetDurationMs) {
  const clients = [
    {
      name: 'VISIONOS',
      clientId: '101',
      clientVersion: '0.1',
      ua: VISIONOS_UA,
      contextClient: {
        clientName: 'VISIONOS',
        clientVersion: '0.1',
        deviceMake: 'Apple',
        deviceModel: 'RealityDevice14,1',
        osName: 'visionOS',
        osVersion: '1.3.21O771',
        hl: 'en',
        timeZone: 'UTC',
        utcOffsetMinutes: 0,
      },
    },
    {
      name: 'IOS',
      clientId: '5',
      clientVersion: '20.10.4',
      ua: IOS_UA,
      contextClient: {
        clientName: 'IOS',
        clientVersion: '20.10.4',
        deviceMake: 'Apple',
        deviceModel: 'iPhone16,2',
        osName: 'iPhone',
        osVersion: '18.3.2.22D82',
        hl: 'en',
        timeZone: 'UTC',
        utcOffsetMinutes: 0,
        ...(visitorData ? { visitorData } : {}),
      },
    },
  ];

  let lastError = null;

  for (const c of clients) {
    try {
      const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': c.ua,
          'X-YouTube-Client-Name': c.clientId,
          'X-YouTube-Client-Version': c.clientVersion,
          Origin: 'https://www.youtube.com',
          ...(visitorData ? { 'X-Goog-Visitor-Id': visitorData } : {}),
        },
        body: JSON.stringify({
          context: { client: c.contextClient },
          videoId,
          contentCheckOk: true,
          racyCheckOk: true,
        }),
      });

      if (!res.ok) continue;

      const data = await res.json();
      if (data?.playabilityStatus?.status !== 'OK') {
        lastError = new Error(
          data?.playabilityStatus?.reason || `Playability: ${data?.playabilityStatus?.status}`
        );
        continue;
      }

      // Check duration if targetDurationMs was provided (within ±25s)
      const lengthSeconds = Number(data?.videoDetails?.lengthSeconds || 0);
      if (targetDurationMs && lengthSeconds > 0) {
        const targetSec = Math.round(targetDurationMs / 1000);
        if (Math.abs(lengthSeconds - targetSec) > 25) {
          return { durationMismatch: true, lengthSeconds };
        }
      }

      const formats = data?.streamingData?.adaptiveFormats || [];
      const m4aFormat =
        formats.find((f) => f.itag === 140 && f.url) ||
        formats.find((f) => f.mimeType?.includes('audio/mp4') && f.url) ||
        formats.find((f) => f.mimeType?.startsWith('audio/') && f.url);

      if (m4aFormat?.url) {
        return {
          streamUrl: m4aFormat.url,
          contentLength: Number(m4aFormat.contentLength) || null,
          mimeType: m4aFormat.mimeType || 'audio/mp4',
          userAgent: c.ua,
          videoId,
          videoTitle: data?.videoDetails?.title || null,
          videoAuthor: data?.videoDetails?.author || null,
          durationMs: lengthSeconds ? lengthSeconds * 1000 : targetDurationMs,
        };
      }
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error('Could not resolve direct .m4a stream URL.');
}

/**
 * Resolve a direct `.m4a` audio stream URL on-device for the given Spotify track.
 */
export async function resolveAudioStreamOnDevice(track) {
  const query =
    [track.artist, track.title].filter(Boolean).join(' - ') + ' audio';

  const { videoIds, visitorData } = await searchYouTubeInnertube(query);

  // Try top candidates (check duration match first if we know the track duration)
  const candidates = videoIds.slice(0, 4);
  for (const videoId of candidates) {
    const result = await fetchDirectM4aStream(
      videoId,
      visitorData,
      track.durationMs
    );
    if (!result.durationMismatch && result.streamUrl) {
      return result;
    }
  }

  // Fallback: take the #1 search result without strict duration filter
  const fallback = await fetchDirectM4aStream(videoIds[0], visitorData, null);
  if (fallback?.streamUrl) {
    return fallback;
  }

  throw new Error('No playable .m4a stream found for this track.');
}
