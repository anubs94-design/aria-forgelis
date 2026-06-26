import React, { useState, useRef, useCallback } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  ScrollView,
  Platform,
  TextInput,
} from 'react-native';
import { Audio } from 'expo-av';
import { StatusBar } from 'expo-status-bar';
import { Switch } from 'react-native';
import { useEffect } from 'react';

const SERVER_HOST = '192.168.1.31';
const SERVER_PORT = 8765;
const SERVER_URL = `wss://${SERVER_HOST}:${SERVER_PORT}`;

const AGENT_TOKEN = 'f259bf284425082d68c23006e8d2be047ac5ddd29c5539ae93dc2c4c34ed1853';

export default function App() {
  const [status, setStatus] = useState('disconnected');
  const [logs, setLogs] = useState([]);
  const [taskText, setTaskText] = useState('');
  const [pendingContext, setPendingContext] = useState(null);
  const [fileChoices, setFileChoices] = useState(null);
  const [voixActive, setVoixActive] = useState(true);
  const voixActiveRef = useRef(true);
  useEffect(() => { voixActiveRef.current = voixActive; }, [voixActive]);
  const ws = useRef(null);

  const addLog = useCallback((message) => {
    const time = new Date().toLocaleTimeString('fr-FR');
    setLogs((prev) => [{ time, message }, ...prev].slice(0, 50));
  }, []);

  const connect = useCallback(() => {
    if (ws.current) {
      addLog('Connexion deja en cours ou active, ignore.');
      return;
    }

    setStatus('connecting');
    addLog(`Connexion vers ${SERVER_URL} ...`);

    let socket;
    try {
      socket = new WebSocket(SERVER_URL);
    } catch (e) {
      setStatus('error');
      addLog(`Erreur creation WebSocket: ${e.message}`);
      return;
    }

    ws.current = socket;

    socket.onopen = () => {
      addLog('Connexion TCP/TLS etablie. Envoi du handshake...');
      setStatus('handshake_pending');

      const handshakeMsg = {
        type: 'handshake',
        token: AGENT_TOKEN,
        platform: Platform.OS,
      };

      socket.send(JSON.stringify(handshakeMsg));
    };

    socket.onmessage = (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch (e) {
        addLog(`Message non-JSON recu: ${event.data}`);
        return;
      }

      switch (data.type) {
        case 'handshake_ack':
          setStatus('connected');
          addLog('Handshake accepte. Connecte au PC Aria.');
          break;

        case 'handshake_refused':
          setStatus('refused');
          addLog(`Handshake refuse: ${data.message || 'raison inconnue'}`);
          socket.close();
          break;

        case 'pong':
          addLog('Pong recu (serveur en vie).');
          break;

        case 'command_result':
          addLog(`Resultat commande: ${JSON.stringify(data)}`);
          break;

        case 'task_result': {
          const r = data.result || {};
          if (data.audio && voixActiveRef.current) {
              jouerAudio(data.audio);
            }
          if (r.statut === 'needs_help' && r.cible === 'choix_fichiers' && r.donnees && r.donnees.fichiers) {
            setFileChoices(r.donnees.fichiers);
            setPendingContext(null);
            addLog(`Aria demande : ${r.message}`);
          } else if (r.statut === 'needs_help' && r.message) {
            setFileChoices(null);
            setPendingContext(r.message);
            addLog(`Aria demande : ${r.message}`);
          } else if (r.statut === 'succes') {
            setFileChoices(null);
            addLog('Tache terminee avec succes.');
          } else {
            setFileChoices(null);
            addLog(`Tache terminee [${r.statut}]: ${r.message || '(pas de message)'}`);
          }
          break;
        }
        case 'open_file_result': {
          addLog(`Ouverture fichier [${data.statut}]: ${data.message}`);
          break;
        }

        default:
          addLog(`Message recu (type=${data.type}): ${JSON.stringify(data)}`);
      }
    };

    socket.onerror = (event) => {
      setStatus('error');
      addLog(`Erreur WebSocket: ${event.message || 'erreur inconnue (verifier le certificat TLS)'}`);
    };

    socket.onclose = (event) => {
      addLog(`Connexion fermee (code=${event.code}, raison=${event.reason || 'aucune'})`);
      setStatus('disconnected');
      ws.current = null;
    };
  }, [addLog]);

  const disconnect = useCallback(() => {
    if (ws.current) {
      ws.current.close();
      ws.current = null;
    }
    setStatus('disconnected');
    addLog('Deconnexion manuelle.');
  }, [addLog]);

  const sendPing = useCallback(() => {
    if (ws.current && status === 'connected') {
      ws.current.send(JSON.stringify({ type: 'ping' }));
      addLog('Ping envoye.');
    } else {
      addLog('Impossible d\'envoyer ping: pas connecte.');
    }
  }, [status, addLog]);

  const sendCommand = useCallback((action, target, params = {}) => {
    if (ws.current && status === 'connected') {
      const cmd = {
        type: 'command',
        command: { action, target, params },
      };
      ws.current.send(JSON.stringify(cmd));
      addLog(`Commande envoyee: ${action} ${target}`);
    } else {
      addLog('Impossible d\'envoyer la commande: pas connecte.');
    }
  }, [status, addLog]);

  const sendOpenChrome = useCallback(() => {
    sendCommand('open_app', 'chrome');
  }, [sendCommand]);

  const sendSearchYoutube = useCallback(() => {
    sendCommand('search_youtube', 'chat mignon');
  }, [sendCommand]);

  const jouerAudio = useCallback(async (base64Audio) => {
      try {
        const { sound } = await Audio.Sound.createAsync(
          { uri: `data:audio/mp3;base64,${base64Audio}` }
        );
        sound.setOnPlaybackStatusUpdate((status) => {
          if (status.didJustFinish) {
            sound.unloadAsync();
          }
        });
        await sound.playAsync();
      } catch (e) {
        addLog(`Erreur lecture audio: ${e}`);
      }
    }, [addLog]);

  const sendOpenFile = useCallback((chemin, nom) => {
    if (ws.current && status === 'connected') {
      ws.current.send(JSON.stringify({ type: 'open_file', chemin }));
      addLog(`Ouverture demandee: ${nom}`);
      setFileChoices(null);
      setPendingContext(null);
    }
  }, [status, addLog]);

  const sendTask = useCallback(() => {
    if (ws.current && status === 'connected' && taskText.trim().length > 0) {
      let finalTask = taskText.trim();
      if (pendingContext) {
        finalTask = `Contexte precedent : tu as demande "${pendingContext}"\nReponse de l'utilisateur : ${taskText.trim()}`;
        setPendingContext(null);
      }
      const msg = { type: 'task', task: finalTask };
      ws.current.send(JSON.stringify(msg));
      addLog(`Tache envoyee: ${taskText.trim()}`);
      setTaskText('');
    } else if (status !== 'connected') {
      addLog("Impossible d\'envoyer: pas connecte.");
    }
  }, [status, taskText, pendingContext, addLog]);

  const statusColor = {
    disconnected: '#888888',
    connecting: '#f0ad4e',
    handshake_pending: '#f0ad4e',
    connected: '#4caf50',
    refused: '#d9534f',
    error: '#d9534f',
  }[status] || '#888888';

  const statusLabel = {
    disconnected: 'Deconnecte',
    connecting: 'Connexion...',
    handshake_pending: 'Handshake en cours...',
    connected: 'Connecte',
    refused: 'Refuse (token invalide)',
    error: 'Erreur',
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
          disabled={status === 'connected' || status === 'connecting' || status === 'handshake_pending'}
        >
          <Text style={styles.buttonText}>Connecter</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.button, styles.buttonPing]}
          onPress={sendPing}
          disabled={status !== 'connected'}
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
          disabled={status !== 'connected'}
        >
          <Text style={styles.buttonText}>Ouvrir Chrome</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.button, styles.buttonCommand]}
          onPress={sendSearchYoutube}
          disabled={status !== 'connected'}
        >
          <Text style={styles.buttonText}>YouTube chat</Text>
        </TouchableOpacity>

      </View>

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
          editable={status === 'connected'}
          multiline
        />
        <TouchableOpacity
          style={[styles.button, styles.buttonSend]}
          onPress={sendTask}
          disabled={status !== 'connected' || taskText.trim().length === 0}
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
    backgroundColor: '#0A0A0F',
    paddingTop: 60,
    paddingHorizontal: 16,
  },
  title: {
    color: '#ffffff',
    fontSize: 20,
    fontWeight: 'bold',
    marginBottom: 16,
    textAlign: 'center',
  },
  statusBadge: {
    alignSelf: 'center',
    marginBottom: 10,
  voixToggleContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  voixToggleLabel: {
    color: '#cccccc',
    fontSize: 13,
    marginRight: 8,
  },
    paddingVertical: 8,
    paddingHorizontal: 20,
    borderRadius: 20,
    marginBottom: 8,
  },
  statusText: {
    color: '#ffffff',
    fontWeight: 'bold',
    fontSize: 14,
  },
  serverInfo: {
    color: '#888888',
    textAlign: 'center',
    fontSize: 12,
    marginBottom: 20,
  },
  buttonRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 20,
  },
  button: {
    flex: 1,
    paddingVertical: 12,
    marginHorizontal: 4,
    borderRadius: 8,
    alignItems: 'center',
  },
  buttonConnect: {
    backgroundColor: '#2196F3',
  },
  buttonPing: {
    backgroundColor: '#673AB7',
  },
  buttonDisconnect: {
    backgroundColor: '#444444',
  },
  buttonCommand: {
    backgroundColor: '#FF9500',
  },
  taskInputContainer: {
    marginBottom: 16,
  },
  taskInput: {
    backgroundColor: '#1a1a1f',
    color: '#ffffff',
    borderRadius: 8,
    padding: 12,
    fontSize: 14,
    minHeight: 60,
    marginBottom: 8,
    textAlignVertical: 'top',
  },
  buttonSend: {
    backgroundColor: '#34C759',
  },
  pendingBanner: {
    backgroundColor: '#2a1f00',
    borderLeftWidth: 3,
    borderLeftColor: '#FF9500',
    borderRadius: 6,
    padding: 10,
    marginBottom: 8,
  },
  pendingBannerText: {
    color: '#FF9500',
    fontSize: 11,
    fontWeight: 'bold',
    marginBottom: 4,
  },
  pendingBannerMessage: {
    color: '#ffffff',
    fontSize: 13,
  },
  fileChoiceButton: {
    backgroundColor: '#1a1a1f',
    borderRadius: 6,
    padding: 10,
    marginTop: 6,
  },
  fileChoiceText: {
    color: '#4FB8D6',
    fontSize: 13,
  },
  buttonText: {
    color: '#ffffff',
    fontWeight: 'bold',
    fontSize: 13,
  },
  logsTitle: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: 'bold',
    marginBottom: 8,
  },
  logsContainer: {
    flex: 1,
    backgroundColor: '#1a1a1f',
    borderRadius: 8,
    padding: 10,
  },
  logLine: {
    color: '#cccccc',
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    marginBottom: 4,
  },
});
