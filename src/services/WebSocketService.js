// src/services/WebSocketService.js
// Encapsule la connexion WebSocket vers l'agent PC Aria.
// La logique reseau/protocole vit ici. L'etat React (useState) reste
// dans le composant appelant, qui passe ses setters via "callbacks".

export function createConnection({ serverUrl, agentToken, callbacks }) {
  let socket;
  try {
    socket = new WebSocket(serverUrl);
  } catch (e) {
    callbacks.onStatusChange("error");
    callbacks.onLog("Erreur creation WebSocket: " + e.message);
    return null;
  }

  callbacks.onStatusChange("connecting");
  callbacks.onLog("Connexion vers " + serverUrl + " ...");

  socket.onopen = () => {
    callbacks.onLog("Connexion TCP/TLS etablie. Envoi du handshake...");
    callbacks.onStatusChange("handshake_pending");

    const handshakeMsg = {
      type: "handshake",
      token: agentToken,
      platform: "mobile",
    };
    socket.send(JSON.stringify(handshakeMsg));
  };

  socket.onmessage = (event) => {
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
        callbacks.onLog("Handshake accepte. Connecte au PC Aria.");
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
    callbacks.onStatusChange("error");
    callbacks.onLog("Erreur WebSocket: " + (event.message || "erreur inconnue (verifier le certificat TLS)"));
  };

  socket.onclose = (event) => {
    callbacks.onLog("Connexion fermee (code=" + event.code + ", raison=" + (event.reason || "aucune") + ")");
    callbacks.onStatusChange("disconnected");
  };

  return socket;
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
    const msg = { type: "task", task: finalTask };
    socket.send(JSON.stringify(msg));
    onLog("Tache envoyee: " + taskText.trim());
    return true;
  } else if (status !== "connected") {
    onLog("Impossible d'envoyer: pas connecte.");
  }
  return false;
}