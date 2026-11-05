import React, { useState, useEffect, useRef } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Image,
  Platform,
  ScrollView,
  Animated,
  SafeAreaView,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import * as Linking from 'expo-linking';
import { extractTrackId, resolveSpotifyTrackOnDevice } from './services/spotify';
import { resolveAudioStreamOnDevice } from './services/audioResolver';

// ============================================================
// Backend Configuration (Fallback for Web & Cloud Mode)
// ============================================================
const API_BASE_URL = (
  process.env.EXPO_PUBLIC_API_URL ||
  'https://tify-api.onrender.com'
).replace(/\/+$/, '');

const API_KEY = process.env.EXPO_PUBLIC_API_KEY || '';

function getApiHeaders() {
  const headers = {};
  if (API_KEY) {
    headers['x-api-key'] = API_KEY;
  }
  return headers;
}

function formatDuration(ms) {
  if (!ms || typeof ms !== 'number') return null;
  const totalSec = Math.round(ms / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
}

function toSafeFileName(name) {
  return (
    name
      .replace(/[\/\\:*?"<>|]/g, '_')
      .replace(/[\x00-\x1f]/g, '')
      .replace(/\s+/g, ' ')
      .trim() || `track_${Date.now()}.m4a`
  );
}

export default function App() {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [step, setStep] = useState('idle'); // 'idle' | 'metadata' | 'downloading' | 'saving' | 'done'
  const [engineUsed, setEngineUsed] = useState(
    Platform.OS === 'web' ? 'Cloud API' : 'On-Device (Residential IP)'
  );
  const [statusMessage, setStatusMessage] = useState('');
  const [progress, setProgress] = useState(0);
  const [currentTrack, setCurrentTrack] = useState(null);
  const [history, setHistory] = useState([]);
  const [banner, setBanner] = useState(null); // { type: 'error' | 'success' | 'info', text: string }

  const progressAnim = useRef(new Animated.Value(0)).current;
  const lastPreviewedIdRef = useRef(null);

  // Listen for incoming Spotify links shared to the mobile app
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const handleDeepLink = (event) => {
      if (event.url) setUrl(event.url);
    };
    const subscription = Linking.addEventListener('url', handleDeepLink);
    return () => subscription.remove();
  }, []);

  // Load recent download history from web localStorage when running in browser
  useEffect(() => {
    if (Platform.OS === 'web' && typeof window !== 'undefined' && window.localStorage) {
      try {
        const saved = window.localStorage.getItem('tify_history');
        if (saved) setHistory(JSON.parse(saved));
      } catch {
        // ignore storage errors
      }
    }
  }, []);

  // Step 2.1: Instant on-device Spotify metadata preview as soon as a valid link is pasted!
  useEffect(() => {
    let cancelled = false;

    const checkPreview = async () => {
      const trimmed = url.trim();
      if (!trimmed || loading) return;

      const trackId = await extractTrackId(trimmed);
      if (!trackId || trackId === lastPreviewedIdRef.current) return;

      lastPreviewedIdRef.current = trackId;
      setPreviewLoading(true);
      try {
        const meta = await resolveSpotifyTrackOnDevice(trimmed);
        if (!cancelled && meta) {
          setCurrentTrack(meta);
        }
      } catch {
        // Ignore preview error; main download flow will handle or fallback
      } finally {
        if (!cancelled) setPreviewLoading(false);
      }
    };

    const timer = setTimeout(checkPreview, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [url, loading]);

  // Animate progress bar smoothly whenever `progress` updates
  useEffect(() => {
    Animated.timing(progressAnim, {
      toValue: Math.max(0, Math.min(100, progress)),
      duration: 300,
      useNativeDriver: false,
    }).start();
  }, [progress]);

  const showBanner = (type, text) => {
    setBanner({ type, text });
    if (type !== 'error') {
      setTimeout(() => {
        setBanner((prev) => (prev?.text === text ? null : prev));
      }, 5500);
    }
  };

  const addToHistory = (item) => {
    setHistory((prev) => {
      const updated = [item, ...prev.filter((x) => x.id !== item.id)].slice(0, 10);
      if (Platform.OS === 'web' && typeof window !== 'undefined' && window.localStorage) {
        try {
          window.localStorage.setItem('tify_history', JSON.stringify(updated));
        } catch {
          // ignore
        }
      }
      return updated;
    });
  };

  const handlePasteClipboard = async () => {
    if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) {
      try {
        const text = await navigator.clipboard.readText();
        if (text) {
          setUrl(text.trim());
          setBanner(null);
        }
      } catch {
        showBanner('info', 'Press Ctrl+V / Cmd+V in the box to paste your link.');
      }
    }
  };

  const delay = (ms) => new Promise((res) => setTimeout(res, ms));

  // ============================================================
  // PATH A (Primary on Mobile): On-Device Extraction + Download
  // Runs directly from the phone's residential IP with 0% -> 100%
  // byte progress via FileSystem.createDownloadResumable!
  // ============================================================
  const runOnDeviceDownload = async (targetUrl) => {
    setEngineUsed('On-Device (Residential IP)');
    setStep('metadata');
    setProgress(5);
    setStatusMessage('Resolving Spotify track metadata on device...');

    const track =
      currentTrack?.id === (await extractTrackId(targetUrl)) && currentTrack?.artist
        ? currentTrack
        : await resolveSpotifyTrackOnDevice(targetUrl);

    setCurrentTrack(track);

    setStep('downloading');
    setProgress(15);
    setStatusMessage('Resolving direct .m4a stream from your mobile IP...');

    const streamInfo = await resolveAudioStreamOnDevice(track);

    const niceName = toSafeFileName(
      `${[track.artist || streamInfo.videoAuthor, track.title].filter(Boolean).join(' - ')}.m4a`
    );
    const fileUri = FileSystem.documentDirectory + niceName;

    setStatusMessage('Downloading native .m4a stream (0%)...');

    // Step 2.3: Real-Time 0% -> 100% byte download progress
    const downloadResumable = FileSystem.createDownloadResumable(
      streamInfo.streamUrl,
      fileUri,
      {
        headers: streamInfo.userAgent
          ? { 'User-Agent': streamInfo.userAgent }
          : undefined,
      },
      (downloadProgress) => {
        const totalBytes =
          downloadProgress.totalBytesExpectedToWrite > 0
            ? downloadProgress.totalBytesExpectedToWrite
            : streamInfo.contentLength || 0;
        if (totalBytes > 0) {
          const rawPct = Math.min(
            100,
            Math.round((downloadProgress.totalBytesWritten / totalBytes) * 100)
          );
          setProgress(15 + Math.round(rawPct * 0.8));
          setStatusMessage(`Downloading native .m4a audio (${rawPct}%)...`);
        }
      }
    );

    const downloadResult = await downloadResumable.downloadAsync();
    if (!downloadResult || downloadResult.status !== 200) {
      throw new Error(
        `Direct stream download returned status ${downloadResult?.status || 'unknown'}`
      );
    }

    setStep('saving');
    setProgress(98);
    setStatusMessage('Opening share sheet...');

    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(downloadResult.uri, {
        mimeType: 'audio/mp4',
        dialogTitle: `Save ${track.title || 'Audio Track'}`,
      });
    }

    return { track, fileName: niceName, localUri: downloadResult.uri };
  };

  // ============================================================
  // PATH B (Web & Automatic Fallback): Cloud Backend (`tify-api`)
  // ============================================================
  const deliverBackendFile = async (sessionId, fallbackFileName, track) => {
    const fileUrl = `${API_BASE_URL}/get-file?sessionId=${encodeURIComponent(sessionId)}`;

    if (Platform.OS === 'web') {
      if (API_KEY) {
        const res = await fetch(fileUrl, { headers: getApiHeaders() });
        if (!res.ok) throw new Error('Failed to stream audio file from server.');
        const blob = await res.blob();
        const blobUrl = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = fallbackFileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.URL.revokeObjectURL(blobUrl);
      } else {
        const a = document.createElement('a');
        a.href = fileUrl;
        a.download = fallbackFileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
      return { localUri: null, fileName: fallbackFileName };
    }

    // Native mobile fallback with real-time byte progress
    const safeName = toSafeFileName(fallbackFileName);
    const fileUri = FileSystem.documentDirectory + safeName;

    const downloadResumable = FileSystem.createDownloadResumable(
      fileUrl,
      fileUri,
      { headers: getApiHeaders() },
      (dp) => {
        if (dp.totalBytesExpectedToWrite > 0) {
          const pct = Math.round(
            (dp.totalBytesWritten / dp.totalBytesExpectedToWrite) * 100
          );
          setProgress(90 + Math.round(pct * 0.1));
        }
      }
    );

    const downloadResult = await downloadResumable.downloadAsync();
    if (!downloadResult || downloadResult.status !== 200) {
      throw new Error('Failed to save audio file to your device.');
    }

    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(downloadResult.uri, {
        mimeType: safeName.endsWith('.mp3') ? 'audio/mpeg' : 'audio/mp4',
        dialogTitle: `Save ${track?.title || 'Audio Track'}`,
      });
    }

    return { localUri: downloadResult.uri, fileName: safeName };
  };

  const runBackendDownload = async (targetUrl) => {
    setEngineUsed('Cloud API');
    setStep('metadata');
    setProgress(8);
    setStatusMessage('Resolving Spotify track info (waking server if idle)...');

    const initResponse = await fetch(
      `${API_BASE_URL}/download?url=${encodeURIComponent(targetUrl)}`,
      { headers: getApiHeaders() }
    );

    let initData;
    try {
      initData = await initResponse.json();
    } catch {
      throw new Error(`Server returned an unexpected response (${initResponse.status}).`);
    }

    if (!initResponse.ok || !initData.success) {
      throw new Error(initData.error || 'Could not initialize download.');
    }

    const { sessionId, track } = initData;
    if (track) setCurrentTrack(track);

    setStep('downloading');
    setProgress(18);
    setStatusMessage('Matching & extracting native .m4a audio stream...');

    let finalFileName = track
      ? `${[track.artist, track.title].filter(Boolean).join(' - ')}.m4a`
      : `track_${Date.now()}.m4a`;

    let isReady = false;
    while (!isReady) {
      await delay(2000);

      const statusResponse = await fetch(
        `${API_BASE_URL}/status?sessionId=${encodeURIComponent(sessionId)}`,
        { headers: getApiHeaders() }
      );
      const statusData = await statusResponse.json();

      if (statusData.track) {
        setCurrentTrack(statusData.track);
      }

      if (typeof statusData.progress === 'number' && statusData.progress > 0) {
        const mapped = 20 + Math.round(statusData.progress * 0.7);
        setProgress(mapped);
        setStatusMessage(`Downloading high-quality audio (${statusData.progress}%)...`);
      }

      if (statusData.status === 'ready') {
        if (statusData.fileName) finalFileName = statusData.fileName;
        isReady = true;
      } else if (statusData.status === 'failed') {
        throw new Error('Backend audio extraction failed for this track.');
      }
    }

    setStep('saving');
    setProgress(92);
    setStatusMessage(
      Platform.OS === 'web'
        ? 'Triggering browser file download...'
        : 'Saving track to device storage...'
    );

    const saved = await deliverBackendFile(sessionId, finalFileName, track);
    return { track: track || currentTrack, fileName: saved.fileName, localUri: saved.localUri };
  };

  // ============================================================
  // Unified Download Trigger (On-Device Primary -> Cloud Fallback)
  // ============================================================
  const triggerDownload = async (overrideUrl) => {
    const targetUrl = (typeof overrideUrl === 'string' ? overrideUrl : url).trim();

    if (!targetUrl) {
      showBanner('error', 'Please paste a Spotify track link first.');
      return;
    }

    if (
      !targetUrl.includes('spotify.com/') &&
      !targetUrl.includes('spotify.link/') &&
      !targetUrl.startsWith('spotify:')
    ) {
      showBanner('error', 'That doesn’t look like a valid Spotify link.');
      return;
    }

    setBanner(null);
    setLoading(true);
    setProgress(4);

    try {
      let result;

      if (Platform.OS !== 'web') {
        // Primary on Mobile: On-Device Residential IP Extraction
        try {
          result = await runOnDeviceDownload(targetUrl);
        } catch (onDeviceErr) {
          console.warn(
            '[!] On-device extraction failed, falling back to tify-api:',
            onDeviceErr.message
          );
          setStatusMessage('Switching to Cloud API fallback...');
          result = await runBackendDownload(targetUrl);
        }
      } else {
        // On Web Browser: Browsers block cross-origin requests to YouTube/googlevideo via CORS,
        // so we preview metadata on-device and stream the audio via tify-api.
        result = await runBackendDownload(targetUrl);
      }

      setProgress(100);
      setStep('done');
      setLoading(false);
      setStatusMessage('Ready!');

      const track = result.track;
      addToHistory({
        id: track?.id || String(Date.now()),
        title: track?.title || result.fileName,
        artist: track?.artist || 'Spotify Track',
        coverUrl: track?.coverUrl || null,
        durationMs: track?.durationMs || null,
        fileName: result.fileName,
        localUri: result.localUri,
        spotifyUrl: targetUrl,
        downloadedAt: new Date().toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        }),
      });

      showBanner(
        'success',
        Platform.OS === 'web'
          ? `Downloaded "${result.fileName}" to your browser downloads!`
          : `Saved "${result.fileName}"!`
      );
      setUrl('');
      lastPreviewedIdRef.current = null;
    } catch (err) {
      console.error(err);
      setLoading(false);
      setStep('idle');
      setProgress(0);
      showBanner(
        'error',
        err.message || 'Could not complete download. Check your connection.'
      );
    }
  };

  const handleHistoryAction = async (item) => {
    if (Platform.OS !== 'web' && item.localUri) {
      try {
        if (await Sharing.isAvailableAsync()) {
          await Sharing.shareAsync(item.localUri);
          return;
        }
      } catch {
        // Fallback to re-downloading if file was cleaned up
      }
    }
    if (item.spotifyUrl) {
      setUrl(item.spotifyUrl);
      triggerDownload(item.spotifyUrl);
    }
  };

  const progressWidth = progressAnim.interpolate({
    inputRange: [0, 100],
    outputRange: ['0%', '100%'],
  });

  const STEPS = [
    { key: 'metadata', label: '1. Metadata' },
    { key: 'downloading', label: '2. Extract .M4A' },
    { key: 'saving', label: '3. Save File' },
  ];

  const getStepState = (key) => {
    const order = ['metadata', 'downloading', 'saving', 'done'];
    const currentIdx = order.indexOf(step);
    const targetIdx = order.indexOf(key);
    if (currentIdx > targetIdx || step === 'done') return 'completed';
    if (currentIdx === targetIdx) return 'active';
    return 'pending';
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="light" />
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.ambientGlow} pointerEvents="none" />

        <View style={styles.mainWrapper}>
          {/* Header / Branding */}
          <View style={styles.header}>
            <View style={styles.badgeRow}>
              <View style={styles.liveDot} />
              <Text style={styles.badgeText}>
                {Platform.OS === 'web'
                  ? 'HYBRID CLOUD .M4A ENGINE'
                  : 'ON-DEVICE RESIDENTIAL IP ENGINE'}
              </Text>
            </View>

            <View style={styles.titleRow}>
              <View style={styles.logoCircle}>
                <Text style={styles.logoIcon}>♫</Text>
              </View>
              <View>
                <Text style={styles.title}>Tify</Text>
                <Text style={styles.subtitle}>
                  SpotyDrop • Zero-Transcode .M4A Downloader
                </Text>
              </View>
            </View>
          </View>

          {/* Non-blocking Toast / Status Banner */}
          {banner && (
            <View
              style={[
                styles.banner,
                banner.type === 'error' && styles.bannerError,
                banner.type === 'success' && styles.bannerSuccess,
              ]}
            >
              <Text style={styles.bannerIcon}>
                {banner.type === 'error' ? '⚠️' : banner.type === 'success' ? '✓' : 'ℹ️'}
              </Text>
              <Text style={styles.bannerText}>{banner.text}</Text>
              <TouchableOpacity onPress={() => setBanner(null)} style={styles.bannerClose}>
                <Text style={styles.bannerCloseText}>✕</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Main Input Card */}
          <View style={styles.card}>
            <Text style={styles.inputLabel}>SPOTIFY TRACK URL</Text>

            <View style={styles.inputRow}>
              <TextInput
                style={styles.input}
                placeholder="https://open.spotify.com/track/..."
                placeholderTextColor="#5E6478"
                value={url}
                onChangeText={(text) => {
                  setUrl(text);
                  if (banner?.type === 'error') setBanner(null);
                }}
                editable={!loading}
                autoCapitalize="none"
                autoCorrect={false}
                onSubmitEditing={() => !loading && triggerDownload()}
              />

              {url.length > 0 && !loading ? (
                <TouchableOpacity
                  style={styles.inlineActionBtn}
                  onPress={() => {
                    setUrl('');
                    lastPreviewedIdRef.current = null;
                  }}
                >
                  <Text style={styles.inlineActionText}>Clear</Text>
                </TouchableOpacity>
              ) : Platform.OS === 'web' && !loading ? (
                <TouchableOpacity
                  style={styles.inlineActionBtn}
                  onPress={handlePasteClipboard}
                >
                  <Text style={styles.inlineActionText}>Paste</Text>
                </TouchableOpacity>
              ) : null}
            </View>

            {/* Primary Download Button */}
            <TouchableOpacity
              style={[styles.primaryButton, loading && styles.primaryButtonDisabled]}
              onPress={() => triggerDownload()}
              disabled={loading}
              activeOpacity={0.85}
            >
              {loading ? (
                <View style={styles.buttonLoadingRow}>
                  <ActivityIndicator color="#061209" size="small" />
                  <Text style={styles.primaryButtonText}>Processing Track...</Text>
                </View>
              ) : (
                <Text style={styles.primaryButtonText}>Download Audio (.m4a)</Text>
              )}
            </TouchableOpacity>

            {/* Quick Sample Track Pill for 1-click testing */}
            {!loading && !url && (
              <TouchableOpacity
                style={styles.samplePill}
                onPress={() =>
                  setUrl('https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b')
                }
              >
                <Text style={styles.samplePillText}>
                  Try sample link: The Weeknd – Blinding Lights →
                </Text>
              </TouchableOpacity>
            )}
          </View>

          {/* Live Track Metadata & Progress Card */}
          {(loading || previewLoading || currentTrack) && (
            <View style={styles.trackCard}>
              {currentTrack ? (
                <View style={styles.trackPreviewRow}>
                  {currentTrack.coverUrl ? (
                    <Image
                      source={{ uri: currentTrack.coverUrl }}
                      style={styles.albumArt}
                    />
                  ) : (
                    <View style={[styles.albumArt, styles.albumArtPlaceholder]}>
                      <Text style={styles.albumArtPlaceholderIcon}>💿</Text>
                    </View>
                  )}

                  <View style={styles.trackMetaInfo}>
                    <View style={styles.formatBadgeRow}>
                      <View style={styles.formatPill}>
                        <Text style={styles.formatPillText}>AAC / .M4A</Text>
                      </View>
                      {currentTrack.durationMs ? (
                        <Text style={styles.durationText}>
                          {formatDuration(currentTrack.durationMs)}
                        </Text>
                      ) : null}
                    </View>

                    <Text style={styles.trackTitle} numberOfLines={2}>
                      {currentTrack.title}
                    </Text>
                    <Text style={styles.trackArtist} numberOfLines={1}>
                      {currentTrack.artist || 'Spotify Track'}
                    </Text>
                  </View>
                </View>
              ) : (
                <View style={styles.skeletonRow}>
                  <View style={styles.skeletonArt} />
                  <View style={styles.skeletonTextCol}>
                    <View style={styles.skeletonLineWide} />
                    <View style={styles.skeletonLineShort} />
                  </View>
                </View>
              )}

              {/* Stepper & Progress Bar */}
              {loading && (
                <View style={styles.progressSection}>
                  <View style={styles.stepsRow}>
                    {STEPS.map((s) => {
                      const state = getStepState(s.key);
                      return (
                        <View
                          key={s.key}
                          style={[
                            styles.stepChip,
                            state === 'active' && styles.stepChipActive,
                            state === 'completed' && styles.stepChipDone,
                          ]}
                        >
                          <Text
                            style={[
                              styles.stepChipText,
                              state === 'active' && styles.stepChipTextActive,
                              state === 'completed' && styles.stepChipTextDone,
                            ]}
                          >
                            {state === 'completed' ? '✓ ' : ''}
                            {s.label}
                          </Text>
                        </View>
                      );
                    })}
                  </View>

                  <View style={styles.progressBarTrack}>
                    <Animated.View
                      style={[styles.progressBarFill, { width: progressWidth }]}
                    />
                  </View>

                  <View style={styles.statusRow}>
                    <Text style={styles.statusText}>{statusMessage}</Text>
                    <Text style={styles.percentText}>{progress}%</Text>
                  </View>
                </View>
              )}
            </View>
          )}

          {/* Recent Downloads Section */}
          {history.length > 0 && (
            <View style={styles.historySection}>
              <View style={styles.historyHeader}>
                <Text style={styles.historyTitle}>RECENT DOWNLOADS</Text>
                <TouchableOpacity onPress={() => setHistory([])}>
                  <Text style={styles.clearHistoryText}>Clear</Text>
                </TouchableOpacity>
              </View>

              {history.map((item) => (
                <View key={item.id} style={styles.historyItem}>
                  {item.coverUrl ? (
                    <Image
                      source={{ uri: item.coverUrl }}
                      style={styles.historyCover}
                    />
                  ) : (
                    <View style={[styles.historyCover, styles.albumArtPlaceholder]}>
                      <Text style={{ fontSize: 16 }}>🎵</Text>
                    </View>
                  )}

                  <View style={styles.historyInfo}>
                    <Text style={styles.historyTrackTitle} numberOfLines={1}>
                      {item.title}
                    </Text>
                    <Text style={styles.historyTrackSub} numberOfLines={1}>
                      {item.artist} • {item.downloadedAt}
                    </Text>
                  </View>

                  <TouchableOpacity
                    style={styles.historyActionBtn}
                    onPress={() => handleHistoryAction(item)}
                  >
                    <Text style={styles.historyActionText}>
                      {Platform.OS === 'web' ? 'Again' : 'Share'}
                    </Text>
                  </TouchableOpacity>
                </View>
              ))}
            </View>
          )}

          {/* Footer info */}
          <View style={styles.footer}>
            <Text style={styles.footerText}>
              Mode: {engineUsed} • Fallback: {API_BASE_URL.replace(/^https?:\/\//, '')}
            </Text>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#090A0F',
  },
  scrollContent: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 36,
    paddingHorizontal: 20,
  },
  ambientGlow: {
    position: 'absolute',
    top: -120,
    width: 380,
    height: 380,
    borderRadius: 190,
    backgroundColor: 'rgba(29, 185, 84, 0.10)',
  },
  mainWrapper: {
    width: '100%',
    maxWidth: 480,
  },
  header: {
    marginBottom: 24,
  },
  badgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(29, 185, 84, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(29, 185, 84, 0.3)',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    marginBottom: 14,
  },
  liveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#1DB954',
    marginRight: 6,
  },
  badgeText: {
    color: '#1ED760',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.2,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  logoCircle: {
    width: 48,
    height: 48,
    borderRadius: 14,
    backgroundColor: '#1DB954',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 14,
  },
  logoIcon: {
    fontSize: 24,
    color: '#051409',
    fontWeight: '900',
  },
  title: {
    fontSize: 30,
    fontWeight: '800',
    color: '#FFFFFF',
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: 13,
    color: '#8B92A5',
    marginTop: 2,
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#171A24',
    borderWidth: 1,
    borderColor: '#2B3040',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginBottom: 16,
  },
  bannerError: {
    backgroundColor: 'rgba(239, 68, 68, 0.12)',
    borderColor: 'rgba(239, 68, 68, 0.4)',
  },
  bannerSuccess: {
    backgroundColor: 'rgba(29, 185, 84, 0.12)',
    borderColor: 'rgba(29, 185, 84, 0.4)',
  },
  bannerIcon: {
    fontSize: 15,
    marginRight: 10,
    color: '#FFFFFF',
  },
  bannerText: {
    flex: 1,
    color: '#E5E7EB',
    fontSize: 13,
    lineHeight: 18,
  },
  bannerClose: {
    paddingLeft: 10,
    paddingVertical: 2,
  },
  bannerCloseText: {
    color: '#8B92A5',
    fontSize: 13,
    fontWeight: '700',
  },
  card: {
    backgroundColor: '#12151E',
    borderRadius: 18,
    padding: 20,
    borderWidth: 1,
    borderColor: '#1F2433',
    marginBottom: 16,
  },
  inputLabel: {
    color: '#8B92A5',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.1,
    marginBottom: 10,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0B0D13',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#252B3B',
    paddingLeft: 14,
    paddingRight: 8,
    height: 52,
    marginBottom: 16,
  },
  input: {
    flex: 1,
    color: '#FFFFFF',
    fontSize: 14,
    height: '100%',
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
  },
  inlineActionBtn: {
    backgroundColor: '#1B2030',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
    marginLeft: 8,
  },
  inlineActionText: {
    color: '#C3C9D9',
    fontSize: 12,
    fontWeight: '600',
  },
  primaryButton: {
    height: 52,
    backgroundColor: '#1DB954',
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButtonDisabled: {
    backgroundColor: '#168D40',
    opacity: 0.85,
  },
  buttonLoadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  primaryButtonText: {
    color: '#051208',
    fontSize: 16,
    fontWeight: '800',
    marginLeft: 8,
  },
  samplePill: {
    marginTop: 14,
    alignSelf: 'center',
    paddingVertical: 4,
  },
  samplePillText: {
    color: '#6E768A',
    fontSize: 12,
  },
  trackCard: {
    backgroundColor: '#12151E',
    borderRadius: 18,
    padding: 18,
    borderWidth: 1,
    borderColor: '#1F2433',
    marginBottom: 16,
  },
  trackPreviewRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  albumArt: {
    width: 72,
    height: 72,
    borderRadius: 12,
    backgroundColor: '#1B2030',
    marginRight: 14,
  },
  albumArtPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  albumArtPlaceholderIcon: {
    fontSize: 26,
  },
  trackMetaInfo: {
    flex: 1,
  },
  formatBadgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 6,
  },
  formatPill: {
    backgroundColor: 'rgba(29, 185, 84, 0.15)',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 5,
    marginRight: 8,
  },
  formatPillText: {
    color: '#1ED760',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.6,
  },
  durationText: {
    color: '#7D8599',
    fontSize: 12,
    fontWeight: '600',
  },
  trackTitle: {
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: '700',
    marginBottom: 3,
  },
  trackArtist: {
    color: '#9CA3B5',
    fontSize: 14,
  },
  skeletonRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  skeletonArt: {
    width: 64,
    height: 64,
    borderRadius: 12,
    backgroundColor: '#1B2030',
    marginRight: 14,
  },
  skeletonTextCol: {
    flex: 1,
  },
  skeletonLineWide: {
    width: '75%',
    height: 14,
    borderRadius: 6,
    backgroundColor: '#1B2030',
    marginBottom: 10,
  },
  skeletonLineShort: {
    width: '45%',
    height: 12,
    borderRadius: 6,
    backgroundColor: '#171B29',
  },
  progressSection: {
    marginTop: 18,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: '#1C202E',
  },
  stepsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  stepChip: {
    flex: 1,
    paddingVertical: 5,
    paddingHorizontal: 6,
    borderRadius: 7,
    backgroundColor: '#0D0F17',
    marginHorizontal: 3,
    alignItems: 'center',
  },
  stepChipActive: {
    backgroundColor: 'rgba(29, 185, 84, 0.16)',
    borderWidth: 1,
    borderColor: 'rgba(29, 185, 84, 0.4)',
  },
  stepChipDone: {
    backgroundColor: '#161B26',
  },
  stepChipText: {
    color: '#5B6275',
    fontSize: 11,
    fontWeight: '600',
  },
  stepChipTextActive: {
    color: '#1ED760',
    fontWeight: '700',
  },
  stepChipTextDone: {
    color: '#9CA3B5',
  },
  progressBarTrack: {
    width: '100%',
    height: 8,
    backgroundColor: '#0B0D13',
    borderRadius: 999,
    overflow: 'hidden',
    marginBottom: 10,
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: '#1DB954',
    borderRadius: 999,
  },
  statusRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  statusText: {
    color: '#8B92A5',
    fontSize: 12,
    flex: 1,
    marginRight: 8,
  },
  percentText: {
    color: '#1ED760',
    fontSize: 12,
    fontWeight: '700',
  },
  historySection: {
    backgroundColor: '#12151E',
    borderRadius: 18,
    padding: 18,
    borderWidth: 1,
    borderColor: '#1F2433',
    marginBottom: 16,
  },
  historyHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  historyTitle: {
    color: '#8B92A5',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.1,
  },
  clearHistoryText: {
    color: '#6E768A',
    fontSize: 12,
  },
  historyItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: '#1A1E2B',
  },
  historyCover: {
    width: 42,
    height: 42,
    borderRadius: 8,
    backgroundColor: '#1B2030',
    marginRight: 12,
  },
  historyInfo: {
    flex: 1,
    marginRight: 10,
  },
  historyTrackTitle: {
    color: '#E5E7EB',
    fontSize: 14,
    fontWeight: '600',
  },
  historyTrackSub: {
    color: '#7D8599',
    fontSize: 12,
    marginTop: 2,
  },
  historyActionBtn: {
    backgroundColor: '#1B2030',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },
  historyActionText: {
    color: '#1ED760',
    fontSize: 12,
    fontWeight: '700',
  },
  footer: {
    alignItems: 'center',
    marginTop: 8,
  },
  footerText: {
    color: '#4B5263',
    fontSize: 11,
  },
});
