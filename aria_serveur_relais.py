"""
═══════════════════════════════════════════════════════════════
 FORGELIS — Serveur relais Aria (mobile)
 aria_serveur_relais.py — v1.0
═══════════════════════════════════════════════════════════════

Pourquoi ce serveur existe :
    Sur mobile, la clé API ne peut PAS être dans l'application
    (n'importe qui pourrait la voler). Ce relais garde la clé
    côté serveur et fait simplement passer les messages.

Architecture SANS ÉTAT (cohérente zéro-données) :
    - Aucune base de données
    - Aucun stockage des messages
    - Aucun compte utilisateur
    - Le message arrive → part vers l'IA → la réponse repart → oubli total

Déploiement gratuit (voir MOBILE_ANDROID.md) :
    Render.com — plan gratuit, HTTPS automatique

Lancement local pour test :
    pip install fastapi uvicorn anthropic
    set ARIA_CLAUDE_KEY=sk-ant-...
    uvicorn aria_serveur_relais:app --reload
"""

import os
from fastapi import FastAPI, HTTPException, Header
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from anthropic import Anthropic
from aria_licence import verifier_licence
from aria_notifications import notifier, ProfilSalarie, Canal, Forfait

# ── Configuration ──
MODELES = {
    "lite":   "claude-haiku-4-5-20251001",
    "smart":  "claude-sonnet-4-6",
    "expert": "claude-opus-4-8",
}

# Limite anti-abus : un message ne peut pas dépasser cette taille
TAILLE_MAX_MESSAGE = 2000
HISTORIQUE_MAX = 10

app = FastAPI(title="Aria Relais", docs_url=None, redoc_url=None)

# CORS : autoriser uniquement tes domaines en production
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # ⚠️ En production : ["https://forgelis.fr", "https://TON-SITE.netlify.app"]
    allow_methods=["POST"],
    allow_headers=["Content-Type"],
)

_client = None
def client() -> Anthropic:
    global _client
    if _client is None:
        cle = os.environ.get("ARIA_CLAUDE_KEY", "").strip()
        if not cle:
            raise HTTPException(503, "Clé API non configurée côté serveur")
        _client = Anthropic(api_key=cle)
    return _client


def prompt_systeme(produit: str, profil: dict) -> str:
    """Identique à aria_app.py — instructions selon produit et profil."""
    if produit == "senior":
        nom = profil.get("name", "")
        return (
            "Tu es Aria, un assistant vocal français conçu pour les seniors. "
            f"Tu parles à {nom or 'l’utilisateur'}. "
            "Règles absolues : phrases courtes et claires, vocabulaire simple, "
            "jamais de jargon technique, toujours patient et rassurant, "
            "une seule information à la fois. Tu vouvoies toujours. "
            "Tu ne donnes JAMAIS de conseil médical, juridique ou financier — "
            "tu rediriges vers un professionnel avec bienveillance. "
            "Réponses de 1 à 3 phrases maximum sauf demande de détails."
        )
    nom = profil.get("name", "")
    age = profil.get("age", 9)
    classe = str(profil.get("classe", "ce2")).upper()
    ptype = profil.get("ptype", "normal")
    niveau = {
        "avance": "L’enfant est en avance : propose des défis du niveau supérieur.",
        "aide": "L’enfant a besoin d’aide : explique très simplement, encourage énormément.",
    }.get(ptype, "L’enfant suit le programme normalement.")
    return (
        f"Tu es Aria, un assistant éducatif français pour enfants. "
        f"Tu parles à {nom or 'un enfant'}, {age} ans, en classe de {classe}. {niveau} "
        "Règles absolues : contenu TOUJOURS adapté aux enfants, jamais de violence "
        "ni de contenu inapproprié. Ton enthousiaste, tutoiement, emojis avec modération. "
        f"Adapte chaque explication au programme de {classe}. "
        "Question sensible → en parler à un parent ou adulte de confiance. "
        "Réponses courtes : 1 à 4 phrases."
    )


class Message(BaseModel):
    role: str
    content: str = Field(max_length=TAILLE_MAX_MESSAGE)


class Demande(BaseModel):
    message: str = Field(min_length=1, max_length=TAILLE_MAX_MESSAGE)
    model: str = "lite"
    product: str = "senior"
    profile: dict = {}
    history: list[Message] = []


@app.post("/ask")
async def ask(d: Demande, x_aria_key: str | None = Header(default=None),
        x_aria_licence: str | None = Header(default=None)):
    """Relais sans état : message → IA → réponse. Rien n'est conservé.
    Si le client fournit SA clé (en-tête X-Aria-Key), elle est utilisée
    → facturation directe sur SON compte, jamais loggée ni stockée."""
    # Protection des coûts : par défaut le relais sert Aria Lite uniquement.
    # Exception : le client utilise SA clé (BYOK) → il paie, il choisit.
    # Pour autoriser Smart/Expert sur ta clé : variable d'env ARIA_RELAY_ALLOW_ALL=1
    cle_client = bool(x_aria_key and x_aria_key.strip().startswith("sk-"))
    tout_autorise = os.environ.get("ARIA_RELAY_ALLOW_ALL", "") == "1"
    # Licence Pro valide → Smart/Expert débloqués sur mobile (secret jamais exposé au client)
    lic = verifier_licence(x_aria_licence) if x_aria_licence else None
    licence_ok = bool(lic and lic.get("valide"))
    modele_demande = d.model if (cle_client or tout_autorise or licence_ok) else "lite"
    modele = MODELES.get(modele_demande, MODELES["lite"])
    produit = d.product if d.product in ("senior", "kids") else "senior"

    historique = [
        {"role": m.role, "content": m.content}
        for m in d.history[-HISTORIQUE_MAX:]
        if m.role in ("user", "assistant")
    ]
    # Le dernier message de l'historique est déjà le message courant côté client ;
    # on s'assure qu'il est bien présent.
    if not historique or historique[-1]["content"] != d.message:
        historique.append({"role": "user", "content": d.message})

    try:
        c = Anthropic(api_key=x_aria_key.strip()) if (x_aria_key and x_aria_key.strip().startswith("sk-")) else client()
        r = c.messages.create(
            model=modele,
            max_tokens=500,
            system=prompt_systeme(produit, d.profile),
            messages=historique,
        )
        texte = "".join(b.text for b in r.content if hasattr(b, "text"))
        return {"reply": texte}
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(502, "Service IA momentanément indisponible")




class NotifDemande(BaseModel):
    """Demande de notification depuis l'interface Industrial."""
    salarie_id: str = Field(min_length=1, max_length=100)
    salarie_nom: str = Field(min_length=1, max_length=100)
    salarie_email: str | None = None
    salarie_tel: str | None = None
    salarie_onesignal: str | None = None
    forfait: str = "tpe"
    titre: str = Field(min_length=1, max_length=100)
    message: str = Field(min_length=1, max_length=500)
    canal: str = "auto"
    urgent: bool = False


@app.post("/notifier")
async def notifier_salarie(d: NotifDemande):
    """Envoie une notification à un salarié — même s'il n'est pas connecté.
    Sans état : aucune donnée stockée, notification envoyée puis oubliée."""
    from aria_notifications import Canal as C, Forfait as F
    salarie = ProfilSalarie(
        id=d.salarie_id,
        nom=d.salarie_nom,
        email=d.salarie_email,
        telephone=d.salarie_tel,
        onesignal_id=d.salarie_onesignal,
        forfait=F(d.forfait) if d.forfait in [f.value for f in F] else F.TPE,
    )
    try:
        canal = C(d.canal) if d.canal in [c.value for c in C] else C.AUTO
        result = await notifier.notifier(
            salarie, d.titre, d.message, canal,
            urgent=d.urgent)
        return {
            "ok": result.push_ok or result.email_ok or result.sms_ok,
            "push": result.push_ok,
            "email": result.email_ok,
            "sms": result.sms_ok,
        }
    except Exception as e:
        raise HTTPException(502, f"Erreur notification : {str(e)[:100]}")


@app.post("/notifier-equipe")
async def notifier_equipe(salaries: list[NotifDemande],
                          titre: str, message: str, canal: str = "auto"):
    """Notifie toute une équipe en parallèle."""
    from aria_notifications import Canal as C, Forfait as F
    from aria_notifications import ProfilSalarie as PS
    team = [PS(id=d.salarie_id, nom=d.salarie_nom, email=d.salarie_email,
               telephone=d.salarie_tel, onesignal_id=d.salarie_onesignal,
               forfait=F(d.forfait) if d.forfait in [f.value for f in F] else F.TPE)
            for d in salaries]
    c = C(canal) if canal in [x.value for x in C] else C.AUTO
    resultats = await notifier.notifier_equipe(team, titre, message, c)
    return {"ok": True, "envoyes": len(resultats)}



async def email_bienvenue(email_client: str, prenom: str, produit: str, plan: str):
    """Envoie l'email de bienvenue après activation de licence.
    Utilise SendGrid si configuré, sinon log silencieux."""
    sg_key = os.environ.get("SENDGRID_API_KEY","")
    sg_from = os.environ.get("SENDGRID_FROM","contact@forgelis.fr")
    if not sg_key:
        print(f"[Bienvenue] Email non envoyé (SendGrid non configuré) → {email_client}")
        return False

    produits_noms = {"senior":"Aria Senior","kids":"Aria Kids","tous":"Aria Senior + Kids","industrial":"Aria Industrial"}
    nom_produit = produits_noms.get(produit, "Aria")
    plans_noms = {"pro":"Pro","solo":"Solo","tpe":"TPE","pme":"PME"}
    nom_plan = plans_noms.get(plan, plan.capitalize())

    html = f"""
<div style="font-family:Arial,sans-serif;max-width:540px;margin:0 auto;padding:0">
  <div style="background:#0B0F1E;padding:20px 24px;border-radius:12px 12px 0 0">
    <span style="font-size:1.2rem;font-weight:800;color:#38BDF8">FORGELIS</span>
    <span style="color:#64748B;font-size:.85rem;margin-left:8px">— La technologie, enfin pour tous</span>
  </div>
  <div style="background:#F8FAFC;padding:28px 24px;border-radius:0 0 12px 12px">
    <h2 style="color:#1E293B;margin:0 0 8px">Bienvenue {prenom} 🎉</h2>
    <p style="color:#475569;font-size:.92rem;line-height:1.7">
      Votre licence <b>{nom_produit} {nom_plan}</b> est maintenant active.<br>
      Voici comment commencer en 3 étapes :
    </p>
    <div style="background:#EFF6FF;border-left:4px solid #2563EB;border-radius:8px;padding:14px 18px;margin:16px 0">
      <div style="color:#1E293B;font-size:.88rem;line-height:2">
        <div>1️⃣ Ouvrez <a href="https://forgelis.fr" style="color:#2563EB;font-weight:600">forgelis.fr</a></div>
        <div>2️⃣ Cliquez sur <b>"🔑 Activer ma licence Pro"</b></div>
        <div>3️⃣ Collez votre clé de licence :</div>
      </div>
      <div style="background:#1E293B;color:#38BDF8;font-family:monospace;font-size:.85rem;padding:10px 14px;border-radius:8px;margin-top:10px;word-break:break-all">
        [CLEF_GENEREE]
      </div>
    </div>
    <p style="color:#64748B;font-size:.78rem;line-height:1.6">
      🔒 Toutes vos données restent sur votre appareil — Forgelis n'en stocke aucune.<br>
      📞 Une question ? Répondez à cet email ou écrivez à <a href="mailto:contact@forgelis.fr" style="color:#2563EB">contact@forgelis.fr</a>
    </p>
    <div style="border-top:1px solid #E2E8F0;margin-top:20px;padding-top:14px">
      <p style="color:#94A3B8;font-size:.72rem;margin:0">
        Forgelis — Ferreira Diogo Victor · SIRET 106 013 899 00013<br>
        2 rue des Écoles, 45600 Guilly · <a href="https://forgelis.fr" style="color:#94A3B8">forgelis.fr</a>
      </p>
    </div>
  </div>
</div>"""

    import aiohttp
    try:
        async with aiohttp.ClientSession() as session:
            payload = {
                "personalizations": [{"to":[{"email":email_client,"name":prenom}]}],
                "from": {"email":sg_from,"name":"Forgelis"},
                "subject": f"🎉 Votre {nom_produit} {nom_plan} est activé !",
                "content": [
                    {"type":"text/plain","value":f"Bienvenue {prenom} ! Votre licence {nom_produit} {nom_plan} est active. Connectez-vous sur forgelis.fr"},
                    {"type":"text/html","value":html}
                ],
            }
            async with session.post("https://api.sendgrid.com/v3/mail/send",
                headers={"Authorization":f"Bearer {sg_key}","Content-Type":"application/json"},
                json=payload, timeout=aiohttp.ClientTimeout(total=8)) as r:
                return r.status in (200,202)
    except Exception as e:
        print(f"[Bienvenue] Erreur email: {e}")
        return False


class LicenceActivation(BaseModel):
    email: str
    prenom: str
    produit: str = "senior"
    plan: str = "pro"
    cle_licence: str


@app.post("/bienvenue")
async def envoyer_bienvenue(d: LicenceActivation):
    """Déclenché par le client après paiement Stripe (webhook).
    Envoie l'email de bienvenue avec la clé de licence."""
    ok = await email_bienvenue(d.email, d.prenom, d.produit, d.plan)
    return {"ok": ok, "message": "Email envoyé" if ok else "SendGrid non configuré — email en attente"}


@app.get("/sante")
def sante():
    """Vérification que le relais est vivant (pour Render)."""
    return {"ok": True}
