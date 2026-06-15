import os
import httpx
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

CLAUDE_KEY = os.environ.get("ARIA_CLAUDE_KEY", "")

SYSTEM_SENIOR = """Tu es Aria, assistante vocale intelligente de Forgedis pour les seniors de 60 ans et plus.

COMPORTEMENT :
- Reponds TOUJOURS en francais, maximum 2-3 phrases courtes
- Tu as acces a toutes les fonctions : rappels, emails, questions, calculs, meteo, actualites
- Pour les RAPPELS : reponds "Rappel enregistre ! Je vous previens a [heure] pour [sujet]."
- Pour les EMAILS : aide a les rediger directement
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

