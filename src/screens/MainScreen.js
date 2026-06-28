// src/screens/MainScreen.js
// Ecran principal Aria Senior. Gere l'etat React et orchestre les
// services WebSocket/Audio/Micro (logique reseau dans src/services/).
//
// MICRO: utilise la reconnaissance vocale NATIVE du telephone via
// expo-speech-recognition. La transcription se fait sur l'appareil
// (pas de fichier audio envoye, pas de proxy, pas de quota cloud).
// On recupere directement le texte via les evenements "result".

import React, { useState, useRef, useEffect, useCallback } from "react";
import {
  View,
  Image,
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
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from "expo-speech-recognition";

import {
  createConnection,
  disconnectSocket,
  sendPing as wsSendPing,
  sendCommand as wsSendCommand,
  sendOpenFile as wsSendOpenFile,
  sendTask as wsSendTask,
} from "../services/WebSocketService";
import { jouerAudio } from "../services/AudioService";
import {
  demanderPermissionMicro,
  demarrerEcoute,
  arreterEcoute,
} from "../services/MicroService";
import { StorageService } from "../services/StorageService";
import { prendrePhotoDocument, analyserDocument } from "../services/DocumentService";

const SERVER_HOST = "192.168.1.31";
const SERVER_PORT = 8765;
const SERVER_URL = "wss://" + SERVER_HOST + ":" + SERVER_PORT;
const AGENT_TOKEN = "f259bf284425082d68c23006e8d2be047ac5ddd29c5539ae93dc2c4c34ed1853";

export default function MainScreen() {
  const [status, setStatus] = useState("disconnected");
  const [logs, setLogs] = useState([]);
  const [taskText, setTaskText] = useState("");
  const [pendingContext, setPendingContext] = useState(null);
  const [fileChoices, setFileChoices] = useState(null);
  const [photoDocument, setPhotoDocument] = useState(null);
  const [explicationDocument, setExplicationDocument] = useState(null);
  const [analyseEnCours, setAnalyseEnCours] = useState(false);
  const [voixActive, setVoixActive] = useState(true);
  const [vocalActif, setVocalActif] = useState(true);
  const [langue, setLangue] = useState("fr-FR");
  const [ecouteActive, setEcouteActive] = useState(false);
  const voixActiveRef = useRef(voixActive);
  const socketRef = useRef(null);

  useEffect(() => {
    voixActiveRef.current = voixActive;
  }, [voixActive]);

  useEffect(() => {
    StorageService.getProfile().then((profile) => {
      if (profile && profile.langue) {
        setLangue(profile.langue);
      }
      if (profile && profile.vocal === false) {
        setVocalActif(false);
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

  // --- Reconnaissance vocale native ---

  useSpeechRecognitionEvent("start", () => {
    setEcouteActive(true);
    addLog("Ecoute en cours...");
  });

  useSpeechRecognitionEvent("end", () => {
    setEcouteActive(false);
  });

  useSpeechRecognitionEvent("result", (event) => {
    const texte = event.results && event.results[0] ? event.results[0].transcript : "";
    if (texte && texte.trim().length > 0) {
      addLog("Reconnu : " + texte);
      sendTask(texte);
    } else {
      addLog("Rien compris, reessayez.");
    }
  });

  useSpeechRecognitionEvent("error", (event) => {
    setEcouteActive(false);
    addLog("Erreur reconnaissance: " + (event.error || "inconnue") + " " + (event.message || ""));
  });

  const demarrerEcouteMicro = useCallback(async () => {
    const ok = await demanderPermissionMicro(addLog);
    if (!ok) return;
    try {
      demarrerEcoute(langue);
    } catch (e) {
      addLog("Erreur demarrage ecoute: " + e.message);
    }
  }, [langue, addLog]);

  const arreterEcouteMicro = useCallback(() => {
    try {
      arreterEcoute();
    } catch (e) {
      addLog("Erreur arret ecoute: " + e.message);
    }
  }, [addLog]);

  const prendrePhoto = useCallback(async () => {
    const resultat = await prendrePhotoDocument(addLog);
    if (resultat) {
      setPhotoDocument(resultat);
      setExplicationDocument(null);
    }
  }, [addLog]);

  const envoyerDocumentAAria = useCallback(async () => {
    if (!photoDocument || !photoDocument.base64) return;
    setAnalyseEnCours(true);
    const texte = await analyserDocument(photoDocument.base64, addLog);
    setAnalyseEnCours(false);
    if (texte) {
      setExplicationDocument(texte);
    } else {
      Alert.alert("Erreur", "Aria n'a pas pu analyser ce document. Reessayez.");
    }
  }, [photoDocument, addLog]);

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

      {vocalActif && (
        <TouchableOpacity
          style={[
            styles.micButton,
            ecouteActive && styles.micButtonActive,
          ]}
          onPressIn={demarrerEcouteMicro}
          onPressOut={arreterEcouteMicro}
          disabled={status !== "connected"}
        >
          <Text style={styles.micButtonText}>
            {ecouteActive
              ? "Relachez quand vous avez fini"
              : "Maintenez pour parler"}
          </Text>
        </TouchableOpacity>
      )}

      <TouchableOpacity style={styles.docButton} onPress={prendrePhoto}>
        <Text style={styles.docButtonText}>Photographier un document</Text>
      </TouchableOpacity>

      {photoDocument && (
        <View style={styles.photoPreviewContainer}>
          <Image
            source={{ uri: photoDocument.uri }}
            style={styles.photoPreview}
            resizeMode="contain"
          />
          <View style={styles.photoActionsRow}>
            <TouchableOpacity
              style={[styles.photoActionButton, styles.photoActionRetry]}
              onPress={prendrePhoto}
            >
              <Text style={styles.buttonText}>Reprendre</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.photoActionButton, styles.photoActionClear]}
              onPress={() => {
                setPhotoDocument(null);
                setExplicationDocument(null);
              }}
            >
              <Text style={styles.buttonText}>Effacer</Text>
            </TouchableOpacity>
          </View>
        </View>

        <TouchableOpacity
          style={styles.docSendButton}
          onPress={envoyerDocumentAAria}
          disabled={analyseEnCours}
        >
          <Text style={styles.buttonText}>
            {analyseEnCours ? "Aria lit le document..." : "Envoyer a Aria"}
          </Text>
        </TouchableOpacity>

        {explicationDocument && (
          <View style={styles.explicationContainer}>
            <Text style={styles.explicationTitle}>Aria explique :</Text>
            <Text style={styles.explicationText}>{explicationDocument}</Text>
          </View>
        )}
      )}

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
  docButton: {
    backgroundColor: "#1a1a1f",
    borderWidth: 1,
    borderColor: "#4FB8D6",
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
    marginBottom: 12,
  },
  docButtonText: {
    color: "#4FB8D6",
    fontWeight: "bold",
    fontSize: 14,
  },
  photoPreviewContainer: {
    backgroundColor: "#1a1a1f",
    borderRadius: 10,
    padding: 10,
    marginBottom: 16,
    alignItems: "center",
  },
  photoPreview: {
    width: "100%",
    height: 220,
    borderRadius: 8,
    marginBottom: 10,
  },
  photoActionsRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    width: "100%",
  },
  photoActionButton: {
    flex: 1,
    paddingVertical: 10,
    marginHorizontal: 4,
    borderRadius: 8,
    alignItems: "center",
  },
  photoActionRetry: {
    backgroundColor: "#2196F3",
  },
  photoActionClear: {
    backgroundColor: "#444444",
  },
  docSendButton: {
    backgroundColor: "#34C759",
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 10,
  },
  explicationContainer: {
    backgroundColor: "#1a2a1f",
    borderLeftWidth: 3,
    borderLeftColor: "#34C759",
    borderRadius: 8,
    padding: 12,
    marginTop: 12,
  },
  explicationTitle: {
    color: "#34C759",
    fontWeight: "bold",
    fontSize: 13,
    marginBottom: 6,
  },
  explicationText: {
    color: "#ffffff",
    fontSize: 14,
    lineHeight: 20,
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