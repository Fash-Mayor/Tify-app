import React, { useState, useEffect } from 'react';
import { StyleSheet, Text, View, TextInput, TouchableOpacity, ActivityIndicator, Alert } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import * as Linking from 'expo-linking';

const NGROK_BASE_URL = 'https://thievishly-patellate-rayna.ngrok-free.dev'; 

export default function App() {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');

  useEffect(() => {
    const handleDeepLink = (event) => { if (event.url) setUrl(event.url); };
    const subscription = Linking.addEventListener('url', handleDeepLink);
    return () => subscription.remove();
  }, []);

  // Helper function to sleep/pause between server checks
  const delay = (ms) => new Promise(res => setTimeout(res, ms));

  const triggerDownload = async () => {
    if (!url.trim()) {
      Alert.alert('Error', 'Please enter a Spotify link!');
      return;
    }

    setLoading(true);
    setStatus('Waking up your PC server...');

    try {
      // 1. Trigger the download to get a session ID
      const initResponse = await fetch(`${NGROK_BASE_URL}/download?url=${encodeURIComponent(url.trim())}`);
      const initData = await initResponse.json();

      if (!initData.success) throw new Error("Could not initialize download.");
      const sessionId = initData.sessionId;

      // 2. Poll the server status until it changes from 'downloading'
      let isReady = false;
      while (!isReady) {
        setStatus('PC is downloading and converting audio...');
        await delay(3000); // Wait 3 seconds before checking again

        const statusResponse = await fetch(`${NGROK_BASE_URL}/status?sessionId=${sessionId}`);
        const statusData = await statusResponse.json();

        if (statusData.status === 'ready') {
          isReady = true;
        } else if (statusData.status === 'failed') {
          throw new Error("PC engine failed to convert track.");
        }
      }

      // 3. Download the completely ready file instantly
      setStatus('Streaming completed file to phone...');
      const tempFilename = `song_${Date.now()}.mp3`;
      const fileUri = FileSystem.documentDirectory + tempFilename;

      const downloadResult = await FileSystem.downloadAsync(
        `${NGROK_BASE_URL}/get-file?sessionId=${sessionId}`,
        fileUri
      );

      if (downloadResult.status !== 200) throw new Error("Streaming error.");

      setStatus('Success!');
      setLoading(false);

      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(downloadResult.uri);
      } else {
        Alert.alert('Saved', 'Song downloaded to local storage container.');
      }
      
      setUrl('');
      setStatus('');

    } catch (err) {
      console.error(err);
      Alert.alert('Process Aborted', err.message || 'Network communication error.');
      setLoading(false);
      setStatus('');
    }
  };

  return (
    <View style={style.container}>
      <Text style={style.title}>SpotyDrop 🎧</Text>
      <Text style={style.subtitle}>Week 3 6in6 Challenge</Text>
      <TextInput
        style={style.input}
        placeholder="Paste Spotify Song Link Here"
        placeholderTextColor="#888"
        value={url}
        onChangeText={setUrl}
        editable={!loading}
      />
      <TouchableOpacity style={style.button} onPress={triggerDownload} disabled={loading}>
        {loading ? <ActivityIndicator color="#fff" /> : <Text style={style.buttonText}>Beam & Download</Text>}
      </TouchableOpacity>
      {status ? <Text style={style.statusText}>{status}</Text> : null}
    </View>
  );
}

const style = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#121212', alignItems: 'center', justifyContent: 'center', padding: 20 },
  title: { fontSize: 32, fontWeight: 'bold', color: '#1DB954', marginBottom: 5 },
  subtitle: { fontSize: 14, color: '#aaa', marginBottom: 30, textTransform: 'uppercase', letterSpacing: 2 },
  input: { width: '100%', height: 50, backgroundColor: '#1E1E1E', borderRadius: 8, paddingHorizontal: 15, color: '#fff', marginBottom: 20, borderWidth: 1, borderColor: '#333' },
  button: { width: '100%', height: 55, backgroundColor: '#1DB954', borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  buttonText: { color: '#fff', fontSize: 18, fontWeight: 'bold' },
  statusText: { color: '#aaa', marginTop: 20, fontSize: 14, fontStyle: 'italic' }
});