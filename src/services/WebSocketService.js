// src/services/WebSocketService.js
// Encapsule la connexion WebSocket vers l'agent PC Aria.
// La logique reseau/protocole vit ici. L'etat React (useState) reste
// dans le composant appelant, qui passe ses setters via "callbacks".
//
// CONNECTIVITE : essaie d'abord le wifi local (rapide). Si ca ne
// repond pas dans un delai court, bascule automatiquement sur le
// relais Render (fonctionne depuis n'importe ou avec internet).
// Le protocole applicatif (handshake, commandes, taches) est
// identique des deux cotes, transparent pour le composant appelant.

import { PROXY_TOKEN } from "./DocumentService";

const RENDER_RELAIS_URL = "wss://aria-forgelis.onrender.com/relais";
const TIMEOUT_LOCAL_MS = 3000;

function attacherGestionnaires(socket, agentToken, callbacks, libelle, estAbandonne) {
  socket.onopen = () => {
    if (estAbandonne()) return;
    callbacks.onLog("Connexion etablie (" + libelle + "). Envoi du handshake...");
    callbacks.onStatusChange("handshake_pending");
    socket.send(JSON.stringify({ type: "handshake", token: agentToken, platform: "mobile" }));
  };

  socket.onmessage = (event) => {
    if (estAbandonne()) return;
    let data;
    try {
      data = JSON.parse(event.data);
    } catch (e) {
      callbacks.onLog("Message non-JSON recu: " + event.data);
      return;
    }

    switch (data.type) {
      case "handshake_ack":
        callbacks.onStatusChange("connected");
        callbacks.onLog("Handshake accepte. Connecte au PC Aria (" + libelle + ").");
        break;

      case "handshake_refused":
        callbacks.onStatusChange("refused");
        callbacks.onLog("Handshake refuse: " + (data.message || "raison inconnue"));
        socket.close();
        break;

      case "pong":
        callbacks.onLog("Pong recu (serveur en vie).");
        if (callbacks.onPong) callbacks.onPong();
        break;

      case "command_result":
        callbacks.onLog("Resultat commande: " + JSON.stringify(data));
        if (callbacks.onCommandResult) callbacks.onCommandResult(data);
        break;

      case "task_result": {
        const r = data.result || {};
        if (data.audio && callbacks.onAudio) {
          callbacks.onAudio(data.audio);
        }
        if (callbacks.onTaskResult) callbacks.onTaskResult(r);
        break;
      }

      case "open_file_result":
        callbacks.onLog("Ouverture fichier [" + data.statut + "]: " + data.message);
        if (callbacks.onOpenFileResult) callbacks.onOpenFileResult(data);
        break;

      default:
        callbacks.onLog("Message recu (type=" + data.type + "): " + JSON.stringify(data));
    }
  };

  socket.onerror = (event) => {
    if (estAbandonne()) return;
    callbacks.onStatusChange("error");
    callbacks.onLog("Erreur WebSocket (" + libelle + "): " + (event.message || "erreur inconnue (verifier le certificat TLS)"));
  };

  socket.onclose = (event) => {
    if (estAbandonne()) return;
    callbacks.onLog("Connexion fermee (" + libelle + ", code=" + event.code + ", raison=" + (event.reason || "aucune") + ")");
    callbacks.onStatusChange("disconnected");
  };
}

function demarrerRelais(etat, agentToken, callbacks) {
  const url = RENDER_RELAIS_URL + "?role=phone&token=" + PROXY_TOKEN;
  let socketRelais;
  try {
    socketRelais = new WebSocket(url);
  } catch (e) {
    callbacks.onStatusChange("error");
    callbacks.onLog("Erreur creation WebSocket (relais): " + e.message);
    return;
  }
  attacherGestionnaires(socketRelais, agentToken, callbacks, "relais Internet", () => false);
  etat.socketActif = socketRelais;
}

function basculerVersRelais(ancienSocket, etat, agentToken, callbacks) {
  if (etat.bascule) return;
  etat.bascule = true;
  try { ancienSocket.close(); } catch (e) {}
  callbacks.onLog("Wifi local indisponible, bascule sur le relais Internet...");
  callbacks.onStatusChange("connecting");
  demarrerRelais(etat, agentToken, callbacks);
}

function creerFacade(etat) {
  return {
    close: () => {
      try { if (etat.socketActif) etat.socketActif.close(); } catch (e) {}
    },
    send: (msg) => {
      if (etat.socketActif && etat.socketActif.readyState === WebSocket.OPEN) {
        etat.socketActif.send(msg);
      }
    },
  };
}

export function createConnection({ serverUrlLocal, agentToken, callbacks }) {
  const etat = { bascule: false, socketActif: null };

  callbacks.onStatusChange("connecting");
  callbacks.onLog("Tentative en wifi local...");

  let socketLocal;
  try {
    socketLocal = new WebSocket(serverUrlLocal);
  } catch (e) {
    callbacks.onLog("Wifi local indisponible (" + e.message + "), bascule sur le relais...");
    demarrerRelais(etat, agentToken, callbacks);
    return creerFacade(etat);
  }

  const minuteur = setTimeout(() => {
    basculerVersRelais(socketLocal, etat, agentToken, callbacks);
  }, TIMEOUT_LOCAL_MS);

  socketLocal.addEventListener("open", () => {
    clearTimeout(minuteur);
  });

  socketLocal.addEventListener("error", () => {
    clearTimeout(minuteur);
    basculerVersRelais(socketLocal, etat, agentToken, callbacks);
  });

  attacherGestionnaires(socketLocal, agentToken, callbacks, "wifi local", () => etat.bascule);
  etat.socketActif = socketLocal;

  return creerFacade(etat);
}

export function disconnectSocket(socket) {
  if (socket) {
    socket.close();
  }
}

export function sendPing(socket, status, onLog) {
  if (socket && status === "connected") {
    socket.send(JSON.stringify({ type: "ping" }));
    onLog("Ping envoye.");
  } else {
    onLog("Impossible d'envoyer ping: pas connecte.");
  }
}

export function sendCommand(socket, status, action, target, params, onLog) {
  if (params === undefined) { params = {}; }
  if (socket && status === "connected") {
    const cmd = {
      type: "command",
      command: { action: action, target: target, params: params },
    };
    socket.send(JSON.stringify(cmd));
    onLog("Commande envoyee: " + action + " " + target);
  } else {
    onLog("Impossible d'envoyer la commande: pas connecte.");
  }
}

export function sendOpenFile(socket, status, chemin, nom, onLog) {
  if (socket && status === "connected") {
    socket.send(JSON.stringify({ type: "open_file", chemin: chemin }));
    onLog("Ouverture demandee: " + nom);
  } else {
    onLog("Impossible d'envoyer la commande: pas connecte.");
  }
}

export function sendTask(socket, status, taskText, pendingContext, onLog) {
  if (socket && status === "connected" && taskText.trim().length > 0) {
    let finalTask = taskText.trim();
    if (pendingContext) {
      finalTask = "Contexte precedent : tu as demande \"" + pendingContext + "\"\nReponse de l'utilisateur : " + taskText.trim();
    }
    const maintenant = new Date();
    const heureLocale = maintenant.toLocaleString("fr-FR", {weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit"});
    const msg = { type: "task", task: finalTask, heure_locale: heureLocale };
    socket.send(JSON.stringify(msg));
    onLog("Tache envoyee: " + taskText.trim());
    return true;
  } else if (status !== "connected") {
    onLog("Impossible d'envoyer: pas connecte.");
  }
  return false;
}
