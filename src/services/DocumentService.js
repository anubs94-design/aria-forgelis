// src/services/DocumentService.js
// Capture et prepare une photo de document (courrier, formulaire...) pour
// que l'Assistant Document puisse la faire lire/expliquer par Aria.
//
// BRIQUE 1 : capture + compression uniquement. L'envoi vers le proxy
// vision sera ajoute dans une brique suivante.

import * as ImagePicker from "expo-image-picker";
import * as ImageManipulator from "expo-image-manipulator";

// Demande la permission camera. Retourne true/false.
export async function demanderPermissionCamera(addLog) {
  const { status } = await ImagePicker.requestCameraPermissionsAsync();
  if (status !== "granted") {
    if (addLog) addLog("Permission camera refusee.");
    return false;
  }
  return true;
}

// Ouvre l'appareil photo, capture une image, la compresse.
// Retourne { uri, width, height, base64 } ou null si annule/erreur.
export async function prendrePhotoDocument(addLog) {
  try {
    const ok = await demanderPermissionCamera(addLog);
    if (!ok) return null;

    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ["images"],
      quality: 1,
    });

    if (result.canceled) {
      if (addLog) addLog("Photo annulee.");
      return null;
    }

    const photo = result.assets[0];

    // Redimensionne (max 1600px de large) + compresse en JPEG,
    // avec le base64 pret a etre envoye dans une prochaine brique.
    const manipule = await ImageManipulator.manipulateAsync(
      photo.uri,
      [{ resize: { width: 1600 } }],
      {
        compress: 0.7,
        format: ImageManipulator.SaveFormat.JPEG,
        base64: true,
      }
    );

    if (addLog) {
      addLog("Photo capturee (" + manipule.width + "x" + manipule.height + ").");
    }

    return {
      uri: manipule.uri,
      width: manipule.width,
      height: manipule.height,
      base64: manipule.base64,
    };
  } catch (e) {
    if (addLog) addLog("Erreur capture photo: " + e.message);
    return null;
  }
}

// === BRIQUE 2 : envoi de la photo au proxy vision pour analyse ===

const PROXY_URL = "https://aria-forgelis.onrender.com/vision";
const PROXY_TOKEN = "COLLE_TON_PROXY_TOKEN_ICI";

const PROMPT_ASSISTANT_DOCUMENT =
  "Tu es Aria, assistante vocale intelligente pour seniors et personnes en " +
  "situation de handicap. L'utilisateur te montre une photo d'un courrier, " +
  "formulaire ou document administratif.\n\n" +
  "TON ROLE :\n" +
  "1. Identifie le document (qui l'envoie, de quoi ca parle).\n" +
  "2. Explique en 2-3 phrases SIMPLES ce qu'on lui demande, sans jargon.\n" +
  "3. Indique s'il y a une echeance ou une urgence.\n" +
  "4. Propose une aide concrete (repondre en ligne, dicter une reponse...).\n\n" +
  "Reponds TOUJOURS en francais, chaleureux et clair. Si la photo est trop " +
  "floue ou illisible, dis-le simplement et demande de reprendre la photo.";

// Envoie l'image (base64) au proxy vision, retourne le texte d'explication
// ou null en cas d'erreur (avec log).
export async function analyserDocument(base64, addLog) {
  try {
    if (addLog) addLog("Envoi du document a Aria...");

    const payload = {
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: [{ type: "text", text: PROMPT_ASSISTANT_DOCUMENT }],
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/jpeg",
                data: base64,
              },
            },
            {
              type: "text",
              text: "Voici la photo du document. Explique-moi simplement de quoi il s'agit.",
            },
          ],
        },
      ],
    };

    const response = await fetch(PROXY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: PROXY_TOKEN, payload: payload }),
    });

    const data = await response.json();

    if (data.erreur) {
      if (addLog) addLog("Erreur Aria: " + data.erreur);
      return null;
    }

    const texte =
      data.content && data.content[0] && data.content[0].text
        ? data.content[0].text
        : null;

    if (!texte) {
      if (addLog) addLog("Reponse vide ou inattendue d'Aria.");
      return null;
    }

    if (addLog) addLog("Aria a explique le document.");
    return texte;
  } catch (e) {
    if (addLog) addLog("Erreur envoi document: " + e.message);
    return null;
  }
}
