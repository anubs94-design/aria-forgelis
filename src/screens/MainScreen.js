// src/screens/MainScreen.js
// Ecran principal Aria Senior. Gere l'etat React et orchestre les
// services WebSocket/Audio/Micro (logique reseau dans src/services/).
//
// MICRO: utilise la reconnaissance vocale NATIVE du telephone via
// expo-speech-recognition. La transcription se fait sur l'appareil
// (pas de fichier audio envoye, pas de proxy, pas de quota cloud).
// On recupere directement le texte via les evenements "result".
//
// DESIGN: charte FORGEDIS (palette du site vitrine forgedis.fr).
// Zone "debug" (Connecter/Ping/Chrome/YouTube/Logs) masquee par
// defaut, visible en triple-tapant le titre "Aria".

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
import { prendrePhotoDocument, analyserDocument, demanderAideReponse, decrireImage } from "../services/DocumentService";

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
  const [reponseDocument, setReponseDocument] = useState(null);
  const [analyseReponseEnCours, setAnalyseReponseEnCours] = useState(false);
  const [descriptionImage, setDescriptionImage] = useState(null);
  const [descriptionEnCours, setDescriptionEnCours] = useState(false);
  const [analyseEnCours, setAnalyseEnCours] = useState(false);
  const [voixActive, setVoixActive] = useState(true);
  const [vocalActif, setVocalActif] = useState(true);
  const [langue, setLangue] = useState("fr-FR");
  const [ecouteActive, setEcouteActive] = useState(false);
  const [debugVisible, setDebugVisible] = useState(false);
  const voixActiveRef = useRef(voixActive);
  const socketRef = useRef(null);
  const tapTimesRef = useRef([]);

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

  const handleTitlePress = useCallback(() => {
    const now = Date.now();
    tapTimesRef.current = [...tapTimesRef.current.filter((t) => now - t < 1000), now];
    if (tapTimesRef.current.length >= 3) {
      tapTimesRef.current = [];
      setDebugVisible((v) => !v);
    }
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
      serverUrlLocal: SERVER_URL,
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
      disconnected: "#6D7799",
      connecting: "#FFA500",
      handshake_pending: "#FFA500",
      connected: "#5BE3D8",
      refused: "#FF7A59",
      error: "#FF7A59",
    }[status] || "#6D7799";

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
      <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
        <StatusBar style="light" />

        <TouchableOpacity activeOpacity={1} onPress={handleTitlePress}>
          <Text style={styles.title}>Aria</Text>
          <Text style={styles.subtitle}>Votre assistant</Text>
        </TouchableOpacity>

        <View style={[styles.statusBadge, { backgroundColor: statusColor }]}>
          <Text style={styles.statusText}>{statusLabel}</Text>
        </View>

        {/* ===== ZONE CLIENT : fonctions principales ===== */}

        {vocalActif && (
          <TouchableOpacity
            style={[
              styles.primaryButton,
              ecouteActive && styles.primaryButtonListening,
            ]}
            onPressIn={demarrerEcouteMicro}
            onPressOut={arreterEcouteMicro}
            disabled={status !== "connected"}
          >
            <Text style={styles.primaryButtonText}>
              {ecouteActive ? "Relachez quand vous avez fini" : "Parler a Aria"}
            </Text>
            <Text style={styles.primaryButtonSub}>
              {ecouteActive ? "Aria vous ecoute..." : "Maintenez pour parler"}
            </Text>
          </TouchableOpacity>
        )}

        <TouchableOpacity style={styles.secondaryButton} onPress={prendrePhoto}>
          <Text style={styles.secondaryButtonText}>Photographier un document</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.secondaryButton} onPress={async () => {
            setDescriptionImage(null);
            setExplicationDocument(null);
            setReponseDocument(null);
            setDescriptionEnCours(true);
            const photo = await prendrePhotoDocument(addLog);
            if (photo) {
              const desc = await decrireImage(photo.base64, addLog);
              if (desc) setDescriptionImage(desc);
            }
            setDescriptionEnCours(false);
          }}>
            <Text style={styles.secondaryButtonText}>{descriptionEnCours ? "Aria regarde..." : "Decrire une image"}</Text>
          <Text style={styles.secondaryButtonSub}>Aria le lit et vous l'explique</Text>
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
                style={styles.ghostButton}
                onPress={prendrePhoto}
              >
                <Text style={styles.ghostButtonText}>Reprendre</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.ghostButton}
                onPress={() => {
                  setPhotoDocument(null);
                  setExplicationDocument(null);
                }}
              >
                <Text style={styles.ghostButtonText}>Effacer</Text>
              </TouchableOpacity>
            </View>

            <TouchableOpacity
              style={styles.docSendButton}
              onPress={envoyerDocumentAAria}
              disabled={analyseEnCours}
            >
              <Text style={styles.docSendButtonText}>
                {analyseEnCours ? "Aria lit le document..." : "Envoyer a Aria"}
              </Text>
            </TouchableOpacity>

            {explicationDocument && (
              <View style={styles.explicationContainer}>
                {explicationDocument.startsWith("[ARNAQUE]") && (
                  <View style={{backgroundColor: "#FF3B30", borderRadius: 10, padding: 12, marginBottom: 10, flexDirection: "row", alignItems: "center"}}>
                    <Text style={{fontSize: 22, marginRight: 8}}>{String.fromCodePoint(0x26A0, 0xFE0F)}</Text>
                    <Text style={{color: "#FFFFFF", fontWeight: "bold", fontSize: 15, flex: 1}}>ATTENTION : Ce document semble etre une arnaque !</Text>
                  </View>
                )}
                {explicationDocument.startsWith("[SUR]") && (
                  <View style={{backgroundColor: "#34C759", borderRadius: 10, padding: 12, marginBottom: 10, flexDirection: "row", alignItems: "center"}}>
                    <Text style={{fontSize: 22, marginRight: 8}}>{String.fromCodePoint(0x2705)}</Text>
                    <Text style={{color: "#FFFFFF", fontWeight: "bold", fontSize: 15, flex: 1}}>Ce document semble authentique.</Text>
                  </View>
                )}
                <Text style={styles.explicationTitle}>Aria explique :</Text>
                <Text style={styles.explicationText}>{explicationDocument.replace(/^\[ARNAQUE\]\n?/, "").replace(/^\[SUR\]\n?/, "")}</Text>

              <View style={{flexDirection: "row", justifyContent: "space-between", marginTop: 12, gap: 8}}>
                <TouchableOpacity
                  style={{flex: 1, backgroundColor: "#5BE3D8", borderRadius: 10, paddingVertical: 10, alignItems: "center", opacity: analyseReponseEnCours ? 0.5 : 1}}
                  onPress={async () => {
                    if (analyseReponseEnCours) return;
                    setAnalyseReponseEnCours(true);
                    const aide = await demanderAideReponse(photoDocument.base64, explicationDocument, addLog);
                    if (aide) setReponseDocument(aide);
                    setAnalyseReponseEnCours(false);
                  }}
                  disabled={analyseReponseEnCours}
                >
                  <Text style={{color: "#070B18", fontWeight: "bold", fontSize: 13}}>
                    {analyseReponseEnCours ? "Aria reflechit..." : "Aider a repondre"}
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={{flex: 1, backgroundColor: "#9B8CFF", borderRadius: 10, paddingVertical: 10, alignItems: "center"}}
                  onPress={() => {
                    if (socketRef.current && connectionStatus === "connected" && photoDocument && photoDocument.base64) {
                      socketRef.current.send(JSON.stringify({
                        type: "save_document",
                        image_base64: photoDocument.base64,
                        nom: "courrier_" + new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + ".jpg",
                      }));
                      addLog("Document envoye au PC pour archivage.");
                      alert("Document envoye au PC pour archivage.");
                    } else {
                      alert("Le PC n'est pas connecte. Impossible de ranger le document.");
                    }
                  }}
                >
                  <Text style={{color: "#F0F3FB", fontWeight: "bold", fontSize: 13}}>Ranger sur le PC</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={{flex: 1, backgroundColor: "#FF7A59", borderRadius: 10, paddingVertical: 10, alignItems: "center"}}
                  onPress={() => {
                    setPhotoDocument(null);
                    setExplicationDocument(null);
                    setReponseDocument(null);
                    addLog("Document efface (RGPD).");
                    alert("Document efface de l'appareil.");
                  }}
                >
                  <Text style={{color: "#F0F3FB", fontWeight: "bold", fontSize: 13}}>Effacer (RGPD)</Text>
                </TouchableOpacity>
              </View>

              {reponseDocument && (
                <View style={{marginTop: 12, backgroundColor: "#1a2548", borderRadius: 10, padding: 12}}>
                  <Text style={styles.explicationTitle}>Aide pour repondre :</Text>
                  <Text style={styles.explicationText}>{reponseDocument}</Text>
                </View>
              )}
              </View>
            )}
          </View>
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

          {descriptionImage && (
              <View style={styles.explicationContainer}>
                <Text style={styles.explicationTitle}>Aria decrit :</Text>
                <Text style={styles.explicationText}>{descriptionImage}</Text>
                <TouchableOpacity
                  style={{backgroundColor: "#FF7A59", borderRadius: 10, paddingVertical: 10, alignItems: "center", marginTop: 10}}
                  onPress={() => { setDescriptionImage(null); addLog("Description effacee."); }}
                >
                  <Text style={{color: "#F0F3FB", fontWeight: "bold", fontSize: 13}}>Fermer</Text>
                </TouchableOpacity>
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
            placeholder={pendingContext ? "Ecris ta reponse..." : "Ou ecrivez ici..."}
            placeholderTextColor="#6D7799"
            editable={status === "connected"}
            multiline
          />
          <TouchableOpacity
            style={styles.secondaryButtonSmall}
            onPress={() => sendTask()}
            disabled={status !== "connected" || taskText.trim().length === 0}
          >
            <Text style={styles.secondaryButtonSmallText}>Envoyer</Text>
          </TouchableOpacity>
        </View>

        {/* ===== ZONE DEBUG : masquee par defaut (triple-tap sur "Aria") ===== */}

        {debugVisible && (
          <View style={styles.debugZone}>
            <Text style={styles.debugLabel}>Zone debug (visible: triple-tap sur "Aria")</Text>

            <View style={styles.voixToggleContainer}>
              <Text style={styles.voixToggleLabel}>Voix d Aria</Text>
              <Switch
                value={voixActive}
                onValueChange={setVoixActive}
                trackColor={{ false: "#444", true: "#5BE3D8" }}
              />
            </View>

            <Text style={styles.serverInfo}>{SERVER_URL}</Text>

            <View style={styles.buttonRow}>
              <TouchableOpacity
                style={styles.debugButton}
                onPress={connect}
                disabled={status === "connected" || status === "connecting" || status === "handshake_pending"}
              >
                <Text style={styles.debugButtonText}>Connecter</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.debugButton}
                onPress={sendPing}
                disabled={status !== "connected"}
              >
                <Text style={styles.debugButtonText}>Ping</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.debugButton}
                onPress={disconnect}
              >
                <Text style={styles.debugButtonText}>Deconnecter</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.buttonRow}>
              <TouchableOpacity
                style={styles.debugButton}
                onPress={sendOpenChrome}
                disabled={status !== "connected"}
              >
                <Text style={styles.debugButtonText}>Ouvrir Chrome</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.debugButton}
                onPress={sendSearchYoutube}
                disabled={status !== "connected"}
              >
                <Text style={styles.debugButtonText}>YouTube chat</Text>
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
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  // ===== Palette FORGEDIS =====
  // bg: #070B18 | panel: #111934 | text: #F0F3FB | text-soft: #A6B0CC
  // coral: #FF7A59 | cyan: #5BE3D8 | violet: #9B8CFF

  container: {
    flex: 1,
    backgroundColor: "#070B18",
    paddingTop: 60,
    paddingHorizontal: 20,
  },
  title: {
    color: "#F0F3FB",
    fontSize: 34,
    fontWeight: "800",
    textAlign: "center",
    letterSpacing: -1,
  },
  subtitle: {
    color: "#A6B0CC",
    fontSize: 15,
    textAlign: "center",
    marginBottom: 18,
  },
  statusBadge: {
    alignSelf: "center",
    paddingVertical: 7,
    paddingHorizontal: 18,
    borderRadius: 999,
    marginBottom: 28,
  },
  statusText: {
    color: "#070B18",
    fontWeight: "700",
    fontSize: 13,
  },

  // --- Boutons principaux (client) ---
  primaryButton: {
    backgroundColor: "#FF7A59",
    borderRadius: 20,
    paddingVertical: 26,
    alignItems: "center",
    marginBottom: 16,
    shadowColor: "#FF7A59",
    shadowOpacity: 0.35,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 6,
  },
  primaryButtonListening: {
    backgroundColor: "#5BE3D8",
    shadowColor: "#5BE3D8",
  },
  primaryButtonText: {
    color: "#1a0d08",
    fontWeight: "800",
    fontSize: 20,
    marginBottom: 4,
  },
  primaryButtonSub: {
    color: "#1a0d08",
    fontSize: 14,
    opacity: 0.75,
  },

  secondaryButton: {
    backgroundColor: "#111934",
    borderWidth: 1.5,
    borderColor: "#FF7A59",
    borderRadius: 18,
    paddingVertical: 20,
    alignItems: "center",
    marginBottom: 20,
  },
  secondaryButtonText: {
    color: "#FF7A59",
    fontWeight: "700",
    fontSize: 17,
    marginBottom: 3,
  },
  secondaryButtonSub: {
    color: "#A6B0CC",
    fontSize: 13,
  },

  // --- Photo / explication ---
  photoPreviewContainer: {
    backgroundColor: "#111934",
    borderRadius: 16,
    padding: 12,
    marginBottom: 20,
    alignItems: "center",
  },
  photoPreview: {
    width: "100%",
    height: 220,
    borderRadius: 12,
    marginBottom: 12,
  },
  photoActionsRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    width: "100%",
    marginBottom: 12,
  },
  ghostButton: {
    flex: 1,
    backgroundColor: "rgba(255,255,255,0.04)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.09)",
    paddingVertical: 12,
    marginHorizontal: 4,
    borderRadius: 12,
    alignItems: "center",
  },
  ghostButtonText: {
    color: "#F0F3FB",
    fontWeight: "600",
    fontSize: 14,
  },
  docSendButton: {
    backgroundColor: "#FF7A59",
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: "center",
    width: "100%",
  },
  docSendButtonText: {
    color: "#1a0d08",
    fontWeight: "700",
    fontSize: 15,
  },
  explicationContainer: {
    backgroundColor: "rgba(91,227,216,0.07)",
    borderLeftWidth: 3,
    borderLeftColor: "#5BE3D8",
    borderRadius: 10,
    padding: 14,
    marginTop: 14,
    width: "100%",
  },
  explicationTitle: {
    color: "#5BE3D8",
    fontWeight: "700",
    fontSize: 13,
    marginBottom: 8,
  },
  explicationText: {
    color: "#F0F3FB",
    fontSize: 15,
    lineHeight: 22,
  },

  // --- Champ texte (fallback clavier) ---
  taskInputContainer: {
    marginBottom: 24,
  },
  taskInput: {
    backgroundColor: "#111934",
    color: "#F0F3FB",
    borderRadius: 14,
    padding: 14,
    fontSize: 15,
    minHeight: 60,
    marginBottom: 10,
    textAlignVertical: "top",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.09)",
  },
  secondaryButtonSmall: {
    backgroundColor: "rgba(155,140,255,0.12)",
    borderWidth: 1,
    borderColor: "#9B8CFF",
    borderRadius: 12,
    paddingVertical: 13,
    alignItems: "center",
  },
  secondaryButtonSmallText: {
    color: "#9B8CFF",
    fontWeight: "700",
    fontSize: 14,
  },
  pendingBanner: {
    backgroundColor: "rgba(255,122,89,0.08)",
    borderLeftWidth: 3,
    borderLeftColor: "#FF7A59",
    borderRadius: 10,
    padding: 12,
    marginBottom: 10,
  },
  pendingBannerText: {
    color: "#FF7A59",
    fontSize: 12,
    fontWeight: "700",
    marginBottom: 4,
  },
  pendingBannerMessage: {
    color: "#F0F3FB",
    fontSize: 14,
  },
  fileChoiceButton: {
    backgroundColor: "#111934",
    borderRadius: 8,
    padding: 10,
    marginTop: 6,
  },
  fileChoiceText: {
    color: "#5BE3D8",
    fontSize: 13,
  },

  // --- Zone debug (masquee par defaut) ---
  debugZone: {
    borderTopWidth: 1,
    borderTopColor: "rgba(255,255,255,0.09)",
    paddingTop: 16,
    marginBottom: 30,
  },
  debugLabel: {
    color: "#6D7799",
    fontSize: 11,
    textAlign: "center",
    marginBottom: 14,
    fontStyle: "italic",
  },
  voixToggleContainer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 14,
  },
  voixToggleLabel: {
    color: "#A6B0CC",
    fontSize: 13,
    marginRight: 8,
  },
  serverInfo: {
    color: "#6D7799",
    textAlign: "center",
    fontSize: 12,
    marginBottom: 16,
  },
  buttonRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 12,
  },
  debugButton: {
    flex: 1,
    backgroundColor: "#111934",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.09)",
    paddingVertical: 11,
    marginHorizontal: 4,
    borderRadius: 10,
    alignItems: "center",
  },
  debugButtonText: {
    color: "#A6B0CC",
    fontWeight: "600",
    fontSize: 12,
  },
  logsTitle: {
    color: "#A6B0CC",
    fontSize: 13,
    fontWeight: "700",
    marginBottom: 8,
    marginTop: 8,
  },
  logsContainer: {
    height: 160,
    backgroundColor: "#111934",
    borderRadius: 10,
    padding: 10,
  },
  logLine: {
    color: "#6D7799",
    fontSize: 11,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    marginBottom: 4,
  },
});
