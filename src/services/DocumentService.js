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
export const PROXY_TOKEN = "aria_1bcbb653f5fd462c4ba2243f4bce9f48b6a657ba966ace5e5fe7429540cdd014";

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
              text: "Voici la photo du document. ETAPE 1 : verifie d'abord si ce document est une ARNAQUE ou du PHISHING (fautes, urgence excessive, menaces, demande de coordonnees bancaires, faux logos, expediteur suspect, lien ou QR code douteux, numero surtaxe). Commence ta reponse par exactement [ARNAQUE] ou [SUR] sur la premiere ligne, seul. Si [ARNAQUE], explique pourquoi et dis de NE PAS y repondre. Si [SUR], passe a l'ETAPE 2 : explique simplement de quoi il s'agit.",
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
    if (addLog) {
      addLog("Erreur envoi document: " + e.message + " | type: " + e.name + " | base64 len: " + (base64 ? base64.length : "null"));
    }
    return null;
  }
}

// === BRIQUE 3-4 : aide a repondre au document ===
const PROMPT_AIDE_REPONSE =
  "Tu es Aria, assistante vocale intelligente pour seniors. " +
  "L'utilisateur t'a montre un document. Tu l'as deja explique. " +
  "Maintenant il veut que tu l'aides a REPONDRE a ce document.\n\n" +
  "TON ROLE :\n" +
  "1. Propose une reponse claire et polie, prete a envoyer.\n" +
  "2. Si c'est un formulaire, aide a le remplir etape par etape.\n" +
  "3. Si aucune reponse n'est necessaire, dis-le simplement.\n\n" +
  "Reponds TOUJOURS en francais, chaleureux et clair.";

export async function demanderAideReponse(base64, explicationPrecedente, addLog) {
  try {
    if (addLog) addLog("Aria prepare une aide pour repondre...");

    const payload = {
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: [{ type: "text", text: PROMPT_AIDE_REPONSE }],
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
              text: "Voici le document. Tu l'as deja explique ainsi : " + explicationPrecedente + "\n\nMaintenant, aide-moi a y repondre.",
            },
          ],
        },
      ],
    };

    const response = await fetch(PROXY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: PROXY_TOKEN, payload }),
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

    if (addLog) addLog("Aria a prepare une aide pour repondre.");
    return texte;
  } catch (e) {
    if (addLog) {
      addLog("Erreur aide reponse: " + e.message);
    }
    return null;
  }
}

// === DECRIRE IMAGE (malvoyants) ===
const PROMPT_DECRIRE_IMAGE =
  "Tu es Aria, assistante vocale pour seniors et personnes malvoyantes. " +
  "L'utilisateur te montre une photo et a besoin que tu DECRIVES ce que tu vois.\n\n" +
  "TON ROLE :\n" +
  "1. Decris l'image de facon claire, detaillee et vivante.\n" +
  "2. Si c'est une photo de personnes, decris combien il y en a, leur apparence generale, leurs vetements, leurs expressions.\n" +
  "3. Si c'est un lieu, decris l'environnement, les couleurs, l'ambiance.\n" +
  "4. Si c'est un objet, decris sa forme, sa couleur, son etat.\n" +
  "5. Si c'est du texte (etiquette, panneau, ecran), LIS-LE a voix haute.\n\n" +
  "Reponds TOUJOURS en francais, chaleureux et clair. Sois precis mais pas trop long (5-8 phrases).";

export async function decrireImage(base64, addLog) {
  try {
    if (addLog) addLog("Aria regarde l'image...");

    const payload = {
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: [{ type: "text", text: PROMPT_DECRIRE_IMAGE }],
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/jpeg", data: base64 },
            },
            { type: "text", text: "Decris-moi cette image en detail." },
          ],
        },
      ],
    };

    const response = await fetch(PROXY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: PROXY_TOKEN, payload }),
    });

    const data = await response.json();
    if (data.erreur) { if (addLog) addLog("Erreur Aria: " + data.erreur); return null; }

    const texte = data.content && data.content[0] && data.content[0].text ? data.content[0].text : null;
    if (!texte) { if (addLog) addLog("Reponse vide."); return null; }

    if (addLog) addLog("Aria a decrit l'image.");
    return texte;
  } catch (e) {
    if (addLog) addLog("Erreur description: " + e.message);
    return null;
  }
}
