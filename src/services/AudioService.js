// src/services/AudioService.js
// Joue l'audio TTS (voix d'Aria) recu en base64 depuis le PC.

import { Audio } from "expo-av";

export async function jouerAudio(base64Audio, onLog) {
  try {
    const { sound } = await Audio.Sound.createAsync(
      { uri: "data:audio/mp3;base64," + base64Audio }
    );
    sound.setOnPlaybackStatusUpdate((status) => {
      if (status.didJustFinish) {
        sound.unloadAsync();
      }
    });
    await sound.playAsync();
  } catch (e) {
    if (onLog) onLog("Erreur lecture audio: " + e.message);
  }
}