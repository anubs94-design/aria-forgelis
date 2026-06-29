import os
import httpx
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

CLAUDE_KEY = os.environ.get("ARIA_CLAUDE_KEY", "")

SYSTEM_SENIOR = """Tu es Aria, assistante vocale intelligente de Forgedis pour les seniors de 60 ans et plus.

COMPORTEMENT :
- Reponds TOUJOURS en francais, maximum 2-3 phrases courtes
- Tu as acces a toutes les fonctions : rappels, emails, questions, calculs, meteo, actualites
- Pour les RAPPELS : reponds "Rappel enregistre ! Je vous previens a [heure] pour [sujet]."
- Pour les EMAILS : aide a rediger directement
- Pour les QUESTIONS : reponds simplement et clairement
- JAMAIS "je ne peux pas", "dans la version complete", "je comprends"
- Utilise le prenom de l utilisateur quand tu le connais
- Sois chaleureux, patient, encourageant"""

@app.get("/sante")
def sante():
    return {"status": "ok"}

@app.post("/ask")
async def ask(body: dict):
    msg = body.get("message", "")
    system = body.get("system", SYSTEM_SENIOR)
    if not CLAUDE_KEY:
        return {"response": "Cle API manquante"}
    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.post("https://api.anthropic.com/v1/messages",
            headers={"x-api-key": CLAUDE_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json"},
            json={"model": "claude-haiku-4-5-20251001", "max_tokens": 300, "system": system, "messages": [{"role": "user", "content": msg}]})
        data = r.json()
        return {"response": data["content"][0]["text"]}

@app.post("/bienvenue")
async def bienvenue(body: dict):
    return {"ok": True}

PROXY_TOKEN = os.environ.get("ARIA_PROXY_TOKEN", "")

@app.post("/vision")
async def vision(body: dict):
    token_recu = body.get("token", "")
    if not PROXY_TOKEN or token_recu != PROXY_TOKEN:
        return {"erreur": "token_invalide"}
    if not CLAUDE_KEY:
        return {"erreur": "cle_manquante"}
    payload = body.get("payload", {})
    if not payload:
        return {"erreur": "payload_vide"}
    async with httpx.AsyncClient(timeout=60.0) as client:
        r = await client.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": CLAUDE_KEY,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json=payload,
        )
    return r.json()

GOOGLE_SPEECH_KEY = os.environ.get("ARIA_GOOGLE_SPEECH_KEY", "")

@app.post("/transcribe")
async def transcribe(body: dict):
    token_recu = body.get("token", "")
    if not PROXY_TOKEN or token_recu != PROXY_TOKEN:
        return {"erreur": "token_invalide"}
    if not GOOGLE_SPEECH_KEY:
        return {"erreur": "cle_google_manquante"}

    audio_b64 = body.get("audio", "")
    langue = body.get("langue", "fr-FR")
    if not audio_b64:
        return {"erreur": "audio_vide"}

    payload = {
        "config": {
            "languageCode": langue,
        },
        "audio": {
            "content": audio_b64,
        },
    }

    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.post(
            "https://speech.googleapis.com/v1/speech:recognize?key=" + GOOGLE_SPEECH_KEY,
            json=payload,
        )

    data = r.json()

    if "error" in data:
        return {"erreur": data["error"].get("message", "erreur_google")}

    resultats = data.get("results", [])
    if not resultats:
        return {"texte": ""}

    texte = resultats[0]["alternatives"][0]["transcript"]
    return {"texte": texte}


# ===================================================================
# RELAIS WEBSOCKET (Aria disponible partout, pas que sur le wifi local)
# ===================================================================
# Le PC (agent.py) et le telephone se connectent tous les deux a cette
# route avec le MEME token (ARIA_PROXY_TOKEN) et un role different.
# Render ne fait que transmettre les messages de l'un a l'autre, sans
# aucune logique metier (zero stockage, relais transparent comme /vision).

relais_connexions = {}

@app.websocket("/relais")
async def relais(websocket: WebSocket):
    token = websocket.query_params.get("token", "")
    role = websocket.query_params.get("role", "")

    if not PROXY_TOKEN or token != PROXY_TOKEN:
        await websocket.close(code=4001)
        return
    if role not in ("agent", "phone"):
        await websocket.close(code=4002)
        return

    await websocket.accept()

    if token not in relais_connexions:
        relais_connexions[token] = {"agent": None, "phone": None}
    relais_connexions[token][role] = websocket

    autre_role = "phone" if role == "agent" else "agent"

    try:
        while True:
            message = await websocket.receive_text()
            peer = relais_connexions.get(token, {}).get(autre_role)
            if peer is not None:
                try:
                    await peer.send_text(message)
                except Exception:
                    pass
    except WebSocketDisconnect:
        pass
    finally:
        if token in relais_connexions and relais_connexions[token].get(role) is websocket:
            relais_connexions[token][role] = None
