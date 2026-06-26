// src/screens/MainScreen.js
// Ecran principal Aria Senior. Gere l'etat React et orchestre les
// services WebSocket/Audio/Micro (logique reseau dans src/services/).

import React, { useState, useRef, useEffect, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  ScrollView,
  Switch,
  StatusBar,
  Platform,
  Alert,
} from "react-native";
import {
  useAudioRecorder,
  useAudioRecorderState,
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
} from "expo-audio";

import {
  createConnection,
  disconnectSocket,
  sendPing as wsSendPing,
  sendCommand as wsSendCommand,
  sendOpenFile as wsSendOpenFile,
  sendTask as wsSendTask,
} from "../services/WebSocketService";
import { jouerAudio } from "../services/AudioService";
import { transcrireAudio } from "../services/MicroService";
import { StorageService } from "../services/StorageService";

const SERVER_HOST = "192.168.1.31";
const SERVER_PORT = 8765;
const SERVER_URL = "wss://" + SERVER_HOST + ":" + SERVER_PORT;
const AGENT_TOKEN = "f259bf284425082d68c23006e8d2be047ac5ddd29c5539ae93dc2c4c34ed1853";
const PROXY_TOKEN = "aria_1bcbb653f5fd462c4ba2243f4bce9f48b6a657ba966ace5e5fe7429540cdd014";

export default function MainScreen() {
  const [status, setStatus] = useState("disconnected");
  const [logs, setLogs] = useState([]);
  const [taskText, setTaskText] = useState("");
  const [pendingContext, setPendingContext] = useState(null);
  const [fileChoices, setFileChoices] = useState(null);
  const [voixActive, setVoixActive] = useState(true);
  const [langue, setLangue] = useState("fr-FR");
  const [transcription, setTranscription] = useState(false);
  const voixActiveRef = useRef(voixActive);
  const socketRef = useRef(null);

  const audioRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(audioRecorder);

  useEffect(() => {
    voixActiveRef.current = voixActive;
  }, [voixActive]);

  useEffect(() => {
    (async () => {
      const status = await AudioModule.requestRecordingPermissionsAsync();
      if (!status.granted) {
        Alert.alert("Permission requise", "Le micro est necessaire pour parler a Aria.");
      }
      await setAudioModeAsync({
        playsInSilentMode: true,
        allowsRecording: true,
      });
    })();
  }, []);

  useEffect(() => {
    StorageService.getProfile().then((profile) => {
      if (profile && profile.langue) {
        setLangue(profile.langue);
      }
    });
  }, []);

  const addLog = useCallback((message) => {
    const time = new Date().toLocaleTimeString();
    setLogs((prev) => [...prev, { time, message }]);
  }, []);

  const handleTaskResult = useCallback((r) => {
    if (r.statut === "needs_help" && r.cible === "choix_fichiers" && r.donnees && Array.isArray(r.donnees)) {
      setFileChoices(r.donnees);
      setPendingContext(null);
      addLog("Aria demande : " + r.message);
    } else if (r.statut === "needs_help" && r.message) {
      setFileChoices(null);
      setPendingContext(r.message);
      addLog("Aria demande : " + r.message);
    } else if (r.statut === "succes") {
      setFileChoices(null);
      addLog("Tache terminee avec succes.");
    } else {
      setFileChoices(null);
      addLog("Tache terminee [" + r.statut + "]: " + (r.message || "(pas de message)"));
    }
  }, [addLog]);

  const connect = useCallback(() => {
    if (socketRef.current) return;
    const socket = createConnection({
      serverUrl: SERVER_URL,
      agentToken: AGENT_TOKEN,
      callbacks: {
        onLog: addLog,
        onStatusChange: setStatus,
        onTaskResult: handleTaskResult,
        onAudio: (audio) => {
          if (voixActiveRef.current) jouerAudio(audio, addLog);
        },
        onOpenFileResult: (data) => {
          addLog("Ouverture fichier [" + data.statut + "]: " + data.message);
        },
        onCommandResult: (data) => {
          addLog("Resultat commande: " + JSON.stringify(data));
        },
      },
    });
    socketRef.current = socket;
  }, [addLog, handleTaskResult]);

  const disconnect = useCallback(() => {
    disconnectSocket(socketRef.current);
    socketRef.current = null;
  }, []);

  const sendPing = useCallback(() => {
    wsSendPing(socketRef.current, status, addLog);
  }, [status, addLog]);

  const sendCommand = useCallback((action, target, params) => {
    wsSendCommand(socketRef.current, status, action, target, params, addLog);
  }, [status, addLog]);

  const sendOpenChrome = useCallback(() => {
    sendCommand("open_app", "chrome");
  }, [sendCommand]);

  const sendSearchYoutube = useCallback(() => {
    sendCommand("search_youtube", "chat mignon");
  }, [sendCommand]);

  const sendOpenFile = useCallback((chemin, nom) => {
    wsSendOpenFile(socketRef.current, status, chemin, nom, addLog);
    setFileChoices(null);
    setPendingContext(null);
  }, [status, addLog]);

  const sendTask = useCallback((texteOverride) => {
    const texte = texteOverride !== undefined ? texteOverride : taskText;
    const reset = wsSendTask(socketRef.current, status, texte, pendingContext, addLog);
    if (reset) {
      setTaskText("");
      setPendingContext(null);
    }
  }, [status, taskText, pendingContext, addLog]);

  const demarrerEnregistrement = useCallback(async () => {
    try {
      await audioRecorder.prepareToRecordAsync();
      audioRecorder.record();
      addLog("Enregistrement demarre...");
    } catch (e) {
      addLog("Erreur demarrage micro: " + e.message);
    }
  }, [audioRecorder, addLog]);

  const arreterEnregistrement = useCallback(async () => {
    try {
      await audioRecorder.stop();
      const uri = audioRecorder.uri;
      addLog("Enregistrement termine. Transcription en cours...");
      setTranscription(true);

      const texte = await transcrireAudio(uri, langue, PROXY_TOKEN, addLog);

      setTranscription(false);

      if (texte) {
        addLog("Transcrit : " + texte);
        sendTask(texte);
      } else {
        addLog("Transcription vide ou echouee.");
      }
    } catch (e) {
      setTranscription(false);
      addLog("Erreur arret micro: " + e.message);
    }
  }, [audioRecorder, langue, addLog, sendTask]);

  const statusColor =
    {
      disconnected: "#444444",
      connecting: "#FFA500",
      handshake_pending: "#FFA500",
      connected: "#34C759",
      refused: "#FF3B30",
      error: "#FF3B30",
    }[status] || "#444444";

  const statusLabel =
    {
      disconnected: "Deconnecte",
      connecting: "Connexion...",
      handshake_pending: "Handshake en cours...",
      connected: "Connecte",
      refused: "Refuse (token invalide)",
      error: "Erreur",
    }[status] || status;

  return (
    <View style={styles.container}>
      <StatusBar style="light" />
      <Text style={styles.title}>Aria Senior - Test WebSocket</Text>

      <View style={[styles.statusBadge, { backgroundColor: statusColor }]}>
        <Text style={styles.statusText}>{statusLabel}</Text>
      </View>
      <View style={styles.voixToggleContainer}>
        <Text style={styles.voixToggleLabel}>Voix d Aria</Text>
        <Switch
          value={voixActive}
          onValueChange={setVoixActive}
          trackColor={{ false: "#444", true: "#34C759" }}
        />
      </View>

      <Text style={styles.serverInfo}>{SERVER_URL}</Text>

      <View style={styles.buttonRow}>
        <TouchableOpacity
          style={[styles.button, styles.buttonConnect]}
          onPress={connect}
          disabled={status === "connected" || status === "connecting" || status === "handshake_pending"}
        >
          <Text style={styles.buttonText}>Connecter</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.button, styles.buttonPing]}
          onPress={sendPing}
          disabled={status !== "connected"}
        >
          <Text style={styles.buttonText}>Ping</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.button, styles.buttonDisconnect]}
          onPress={disconnect}
        >
          <Text style={styles.buttonText}>Deconnecter</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.buttonRow}>
        <TouchableOpacity
          style={[styles.button, styles.buttonCommand]}
          onPress={sendOpenChrome}
          disabled={status !== "connected"}
        >
          <Text style={styles.buttonText}>Ouvrir Chrome</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.button, styles.buttonCommand]}
          onPress={sendSearchYoutube}
          disabled={status !== "connected"}
        >
          <Text style={styles.buttonText}>YouTube chat</Text>
        </TouchableOpacity>
      </View>

      <TouchableOpacity
        style={[
          styles.micButton,
          recorderState.isRecording && styles.micButtonActive,
          transcription && styles.micButtonTranscribing,
        ]}
        onPressIn={demarrerEnregistrement}
        onPressOut={arreterEnregistrement}
        disabled={status !== "connected" || transcription}
      >
        <Text style={styles.micButtonText}>
          {transcription
            ? "Transcription..."
            : recorderState.isRecording
            ? "Relachez pour envoyer"
            : "Maintenez pour parler"}
        </Text>
      </TouchableOpacity>

      <View style={styles.taskInputContainer}>
        {fileChoices && (
          <View style={styles.pendingBanner}>
            <Text style={styles.pendingBannerText}>Aria propose ces fichiers :</Text>
            {fileChoices.map((fichier, idx) => (
              <TouchableOpacity
                key={idx}
                style={styles.fileChoiceButton}
                onPress={() => sendOpenFile(fichier.chemin, fichier.nom)}
              >
                <Text style={styles.fileChoiceText}>{idx + 1}. {fichier.nom}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {pendingContext && (
          <View style={styles.pendingBanner}>
            <Text style={styles.pendingBannerText}>Aria attend ta reponse :</Text>
            <Text style={styles.pendingBannerMessage}>{pendingContext}</Text>
          </View>
        )}

        <TextInput
          style={styles.taskInput}
          value={taskText}
          onChangeText={setTaskText}
          placeholder={pendingContext ? "Ecris ta reponse..." : "Dis a Aria ce que tu veux faire..."}
          placeholderTextColor="#666666"
          editable={status === "connected"}
          multiline
        />
        <TouchableOpacity
          style={[styles.button, styles.buttonSend]}
          onPress={() => sendTask()}
          disabled={status !== "connected" || taskText.trim().length === 0}
        >
          <Text style={styles.buttonText}>Envoyer</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.logsTitle}>Logs :</Text>
      <ScrollView style={styles.logsContainer}>
        {logs.map((log, idx) => (
          <Text key={idx} style={styles.logLine}>
            [{log.time}] {log.message}
          </Text>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0A0A0F",
    paddingTop: 60,
    paddingHorizontal: 16,
  },
  title: {
    color: "#ffffff",
    fontSize: 20,
    fontWeight: "bold",
    marginBottom: 16,
    textAlign: "center",
  },
  statusBadge: {
    alignSelf: "center",
    paddingVertical: 8,
    paddingHorizontal: 20,
    borderRadius: 20,
    marginBottom: 8,
  },
  voixToggleContainer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 12,
  },
  voixToggleLabel: {
    color: "#cccccc",
    fontSize: 13,
    marginRight: 8,
  },
  statusText: {
    color: "#ffffff",
    fontWeight: "bold",
    fontSize: 14,
  },
  serverInfo: {
    color: "#888888",
    textAlign: "center",
    fontSize: 12,
    marginBottom: 20,
  },
  buttonRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 20,
  },
  button: {
    flex: 1,
    paddingVertical: 12,
    marginHorizontal: 4,
    borderRadius: 8,
    alignItems: "center",
  },
  buttonConnect: {
    backgroundColor: "#2196F3",
  },
  buttonPing: {
    backgroundColor: "#673AB7",
  },
  buttonDisconnect: {
    backgroundColor: "#444444",
  },
  buttonCommand: {
    backgroundColor: "#FF9500",
  },
  micButton: {
    backgroundColor: "#34C759",
    borderRadius: 12,
    paddingVertical: 18,
    alignItems: "center",
    marginBottom: 16,
  },
  micButtonActive: {
    backgroundColor: "#FF3B30",
  },
  micButtonTranscribing: {
    backgroundColor: "#FFA500",
  },
  micButtonText: {
    color: "#ffffff",
    fontWeight: "bold",
    fontSize: 16,
  },
  taskInputContainer: {
    marginBottom: 16,
  },
  taskInput: {
    backgroundColor: "#1a1a1f",
    color: "#ffffff",
    borderRadius: 8,
    padding: 12,
    fontSize: 14,
    minHeight: 60,
    marginBottom: 8,
    textAlignVertical: "top",
  },
  buttonSend: {
    backgroundColor: "#34C759",
  },
  pendingBanner: {
    backgroundColor: "#2a1f00",
    borderLeftWidth: 3,
    borderLeftColor: "#FF9500",
    borderRadius: 6,
    padding: 10,
    marginBottom: 8,
  },
  pendingBannerText: {
    color: "#FF9500",
    fontSize: 11,
    fontWeight: "bold",
    marginBottom: 4,
  },
  pendingBannerMessage: {
    color: "#ffffff",
    fontSize: 13,
  },
  fileChoiceButton: {
    backgroundColor: "#1a1a1f",
    borderRadius: 6,
    padding: 10,
    marginTop: 6,
  },
  fileChoiceText: {
    color: "#4FB8D6",
    fontSize: 13,
  },
  buttonText: {
    color: "#ffffff",
    fontWeight: "bold",
    fontSize: 13,
  },
  logsTitle: {
    color: "#ffffff",
    fontSize: 14,
    fontWeight: "bold",
    marginBottom: 8,
  },
  logsContainer: {
    flex: 1,
    backgroundColor: "#1a1a1f",
    borderRadius: 8,
    padding: 10,
  },
  logLine: {
    color: "#cccccc",
    fontSize: 11,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    marginBottom: 4,
  },
});