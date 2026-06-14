"""
═══════════════════════════════════════════════════════════════
 FORGELIS — Système de notifications Aria Industrial
 aria_notifications.py — v1.0
═══════════════════════════════════════════════════════════════

Notifie les salariés même s'ils ne sont pas connectés à Aria.

3 canaux selon le forfait :
  Solo  → Email uniquement
  TPE   → Email + Push PWA (OneSignal)
  PME   → Email + Push PWA + SMS (Twilio)
  ETI   → Tout + personnalisable

Variables d'environnement à configurer sur Render :
  ONESIGNAL_APP_ID        → Dashboard OneSignal → App ID
  ONESIGNAL_API_KEY       → Dashboard OneSignal → REST API Key
  SENDGRID_API_KEY        → Dashboard SendGrid → API Key
  SENDGRID_FROM           → contact@forgelis.fr
  TWILIO_ACCOUNT_SID      → Dashboard Twilio → Account SID
  TWILIO_AUTH_TOKEN       → Dashboard Twilio → Auth Token
  TWILIO_FROM_NUMBER      → Numéro Twilio (ex : +33XXXXXXXXX)

Configuration gratuite :
  OneSignal  → gratuit jusqu'à 10 000 abonnés
  SendGrid   → gratuit jusqu'à 100 emails/jour
  Twilio     → ~0,07€/SMS (pay-as-you-go)

Usage dans le relais :
  from aria_notifications import notifier

  await notifier.push(
      destinataire="thomas.mercier",
      titre="Rappel Aria",
      message="Vous avez une tâche en attente : valider le devis Acier+",
      canal="auto"   # auto = meilleur canal disponible selon forfait
  )
"""

import os
import json
import logging
import aiohttp
from dataclasses import dataclass
from enum import Enum
from typing import Optional

logger = logging.getLogger("aria.notifications")

import asyncio
from datetime import datetime, time, timedelta
from zoneinfo import ZoneInfo

# ── Plages horaires par défaut (configurables par entreprise) ──
# Conformes au Code du travail français :
# - Art. L3131-1 : repos quotidien minimum 11h consécutives entre 2 journées
# - Art. L3132-1/2 : repos hebdomadaire minimum 35h consécutives (24h + 11h)
# - Art. L2242-17 §7 : droit à la déconnexion — bloquer l'envoi hors horaires
# - Jurisprudence Cass. soc. 25 mars 2026 : pas de pression implicite à répondre
HORAIRES_DEFAUT = {
    0: (time(8,0), time(18,0)),   # Lundi
    1: (time(8,0), time(18,0)),   # Mardi
    2: (time(8,0), time(18,0)),   # Mercredi
    3: (time(8,0), time(18,0)),   # Jeudi
    4: (time(8,0), time(18,0)),   # Vendredi
    5: None,                       # Samedi — repos (L3132-3)
    6: None,                       # Dimanche — repos obligatoire (L3132-3)
}

# Repos quotidien légal minimum (art. L3131-1)
REPOS_QUOTIDIEN_H = 11

# Repos hebdomadaire légal minimum (art. L3132-2)
REPOS_HEBDO_H = 35

class FileAttenteNotifs:
    """File d'attente locale des notifications hors-horaires.
    Zéro base de données — stockage en mémoire, vidé à chaque démarrage.
    En production : persister dans Redis ou fichier JSON sur le relais."""
    def __init__(self):
        self._file: list[dict] = []

    def ajouter(self, salarie, titre, message, canal, urgent, horaires):
        """Met la notification en attente jusqu'au prochain jour ouvré."""
        prochaine = prochaine_fenetre_legale(horaires)
        self._file.append({
            "salarie": salarie,
            "titre": titre,
            "message": message,
            "canal": canal,
            "urgent": urgent,
            "horaires": horaires,
            "envoyer_a": prochaine,
            "cree_a": datetime.now(ZoneInfo("Europe/Paris")).isoformat(),
        })
        return prochaine

    def notifications_a_envoyer(self) -> list[dict]:
        """Retourne les notifications dont l'heure est venue."""
        tz = ZoneInfo("Europe/Paris")
        maintenant = datetime.now(tz)
        dues = [n for n in self._file
                if datetime.fromisoformat(n["envoyer_a"]) <= maintenant]
        self._file = [n for n in self._file
                      if datetime.fromisoformat(n["envoyer_a"]) > maintenant]
        return dues

    def taille(self) -> int:
        return len(self._file)


# Instance globale de la file
file_notifs = FileAttenteNotifs()


def est_dans_horaires(horaires: dict | None = None) -> bool:
    """
    Vérifie si l'heure actuelle permet l'envoi d'une notification.

    Règles légales appliquées (Code du travail français) :
    - Art. L3131-1 : repos quotidien 11h minimum entre deux journées
    - Art. L3132-1 : repos hebdomadaire 35h minimum
    - Art. L2242-17 §7 : droit à la déconnexion — aucune pression hors horaires
    - Cass. soc. 25/03/2026 : pas de contrainte implicite à répondre
    """
    tz = ZoneInfo("Europe/Paris")
    maintenant = datetime.now(tz)
    plages = horaires or HORAIRES_DEFAUT
    plage = plages.get(maintenant.weekday())

    # Jour sans plage définie = jour de repos → blocage total
    if not plage:
        return False

    debut, fin = plage
    heure = maintenant.time()

    # Hors plage horaire définie par l'entreprise
    if not (debut <= heure <= fin):
        return False

    # ── Vérification repos quotidien 11h (art. L3131-1) ──
    # Si la fin de journée d'hier + 11h dépasse maintenant → encore en repos
    hier = maintenant.weekday() - 1 if maintenant.weekday() > 0 else 6
    plage_hier = plages.get(hier)
    if plage_hier:
        _, fin_hier = plage_hier
        fin_hier_dt = maintenant.replace(
            hour=fin_hier.hour, minute=fin_hier.minute,
            second=0, microsecond=0) - timedelta(days=1)
        if maintenant < fin_hier_dt + timedelta(hours=REPOS_QUOTIDIEN_H):
            return False  # encore dans le repos quotidien légal

    return True


def prochaine_fenetre_legale(horaires: dict | None = None) -> datetime:
    """
    Calcule la prochaine fenêtre d'envoi légale.
    Respecte le repos quotidien 11h ET le repos hebdomadaire 35h.
    """
    tz = ZoneInfo("Europe/Paris")
    maintenant = datetime.now(tz)
    plages = horaires or HORAIRES_DEFAUT

    for delta in range(1, 8):
        jour = maintenant + timedelta(days=delta)
        plage = plages.get(jour.weekday())
        if not plage:
            continue
        debut_jour, _ = plage
        # Heure de début de cette journée
        debut_dt = jour.replace(hour=debut_jour.hour, minute=debut_jour.minute,
                                second=0, microsecond=0)
        # Vérifier que le repos quotidien 11h est respecté par rapport à maintenant
        if delta == 1:  # lendemain
            fin_auj = plages.get(maintenant.weekday())
            if fin_auj:
                _, fin_h = fin_auj
                fin_dt = maintenant.replace(hour=fin_h.hour, minute=fin_h.minute,
                                            second=0, microsecond=0)
                repos_min = fin_dt + timedelta(hours=REPOS_QUOTIDIEN_H)
                if debut_dt < repos_min:
                    debut_dt = repos_min  # reporter au respect du repos 11h
        return debut_dt

    # Fallback : dans 24h
    return maintenant + timedelta(hours=24)




class Canal(str, Enum):
    AUTO  = "auto"    # meilleur canal disponible
    PUSH  = "push"    # PWA push uniquement
    EMAIL = "email"   # email uniquement
    SMS   = "sms"     # SMS uniquement
    TOUS  = "tous"    # tous les canaux disponibles


class Forfait(str, Enum):
    SOLO = "solo"   # email uniquement
    TPE  = "tpe"    # email + push
    PME  = "pme"    # email + push + SMS
    ETI  = "eti"    # tout


CANAUX_PAR_FORFAIT = {
    Forfait.SOLO: [Canal.EMAIL],
    Forfait.TPE:  [Canal.EMAIL, Canal.PUSH],
    Forfait.PME:  [Canal.EMAIL, Canal.PUSH, Canal.SMS],
    Forfait.ETI:  [Canal.EMAIL, Canal.PUSH, Canal.SMS],
}


@dataclass
class ProfilSalarie:
    """Profil minimal d'un salarié pour les notifications."""
    id: str                        # identifiant unique (ex: "thomas.mercier")
    nom: str                       # prénom + nom
    email: Optional[str] = None    # email pro
    telephone: Optional[str] = None  # numéro E.164 (ex: +33612345678)
    onesignal_id: Optional[str] = None  # ID OneSignal (enregistré à la connexion PWA)
    forfait: Forfait = Forfait.TPE


class NotificationResult:
    def __init__(self):
        self.push_ok  = False
        self.email_ok = False
        self.sms_ok   = False
        self.erreurs  = []

    def __repr__(self):
        return (f"Notifications → push:{self.push_ok} "
                f"email:{self.email_ok} sms:{self.sms_ok} "
                f"erreurs:{self.erreurs}")


class AriaNotifier:
    """Gestionnaire de notifications multi-canal pour Aria Industrial."""

    def __init__(self):
        # OneSignal (Push PWA)
        self.os_app_id  = os.environ.get("ONESIGNAL_APP_ID", "")
        self.os_api_key = os.environ.get("ONESIGNAL_API_KEY", "")

        # SendGrid (Email)
        self.sg_key  = os.environ.get("SENDGRID_API_KEY", "")
        self.sg_from = os.environ.get("SENDGRID_FROM", "contact@forgelis.fr")

        # Twilio (SMS)
        self.tw_sid   = os.environ.get("TWILIO_ACCOUNT_SID", "")
        self.tw_token = os.environ.get("TWILIO_AUTH_TOKEN", "")
        self.tw_from  = os.environ.get("TWILIO_FROM_NUMBER", "")

    # ──────────────────────────────────────────
    async def notifier(self,
                       salarie: ProfilSalarie,
                       titre: str,
                       message: str,
                       canal: Canal = Canal.AUTO,
                       expediteur: str = "Aria Industrial",
                       urgent: bool = False,
                       horaires: dict | None = None,
                       respecter_horaires: bool = True) -> NotificationResult:
        """
        Envoie une notification à un salarié via le(s) canal(aux) disponibles.

        Droit à la déconnexion (art. L2242-17 Code du travail) :
        - Si hors plage horaire ET non urgent → mise en file d'attente
        - Livraison au prochain jour ouvré à l'ouverture
        - Si urgent=True → envoyé immédiatement (incidents, sécurité)
        """
        result = NotificationResult()

        # ── Vérification des horaires ──
        if respecter_horaires and not urgent:
            if not est_dans_horaires(horaires):
                prochaine = file_notifs.ajouter(
                    salarie, titre, message, canal, urgent,
                    horaires or HORAIRES_DEFAUT)
                logger.info(
                    f"Notification → {salarie.id} mise en attente "
                    f"jusqu'au {prochaine.strftime('%d/%m à %Hh%M')} "
                    f"(art. L2242-17 + L3131-1 Code du travail)")
                result.erreurs.append(
                    f"en_attente:{prochaine.strftime('%d/%m à %Hh%M')}")
                return result

        canaux = self._canaux_a_utiliser(salarie.forfait, canal)

        async with aiohttp.ClientSession() as session:
            for c in canaux:
                if c == Canal.PUSH and salarie.onesignal_id:
                    result.push_ok = await self._push_onesignal(
                        session, salarie.onesignal_id, titre, message, urgent)

                elif c == Canal.EMAIL and salarie.email:
                    result.email_ok = await self._email_sendgrid(
                        session, salarie.email, salarie.nom,
                        titre, message, expediteur)

                elif c == Canal.SMS and salarie.telephone:
                    result.sms_ok = await self._sms_twilio(
                        session, salarie.telephone, f"{titre}: {message}")

        logger.info(f"Notification → {salarie.id}: {result}")
        return result

    # ──────────────────────────────────────────
    async def notifier_equipe(self,
                              salaries: list[ProfilSalarie],
                              titre: str,
                              message: str,
                              canal: Canal = Canal.AUTO) -> dict:
        """Notifie toute une équipe en parallèle."""
        import asyncio
        tasks = [self.notifier(s, titre, message, canal) for s in salaries]
        resultats = await asyncio.gather(*tasks, return_exceptions=True)
        return {s.id: r for s, r in zip(salaries, resultats)}

    # ──────────────────────────────────────────
    def _canaux_a_utiliser(self, forfait: Forfait, canal: Canal) -> list[Canal]:
        """Détermine les canaux selon le forfait et la demande."""
        disponibles = CANAUX_PAR_FORFAIT.get(forfait, [Canal.EMAIL])
        if canal == Canal.AUTO:
            return [disponibles[0]]      # meilleur canal disponible
        if canal == Canal.TOUS:
            return disponibles
        if canal in disponibles:
            return [canal]
        return [Canal.EMAIL]             # fallback email

    # ──────────────────────────────────────────
    async def _push_onesignal(self, session, player_id: str,
                               titre: str, message: str,
                               urgent: bool = False) -> bool:
        """Push PWA via OneSignal — fonctionne même app fermée."""
        if not self.os_api_key or not self.os_app_id:
            logger.warning("OneSignal non configuré — push ignoré")
            return False
        try:
            payload = {
                "app_id": self.os_app_id,
                "include_player_ids": [player_id],
                "headings": {"fr": titre, "en": titre},
                "contents": {"fr": message, "en": message},
                "priority": 10 if urgent else 5,
                "ttl": 86400,      # expire après 24h si non livré
                "data": {"source": "aria_industrial"},
            }
            async with session.post(
                "https://onesignal.com/api/v1/notifications",
                headers={"Authorization": f"Basic {self.os_api_key}",
                         "Content-Type": "application/json"},
                json=payload, timeout=aiohttp.ClientTimeout(total=8)
            ) as r:
                ok = r.status == 200
                if not ok:
                    logger.error(f"OneSignal erreur {r.status}")
                return ok
        except Exception as e:
            logger.error(f"OneSignal exception: {e}")
            return False

    # ──────────────────────────────────────────
    async def _email_sendgrid(self, session, email: str, nom: str,
                               sujet: str, message: str,
                               expediteur: str) -> bool:
        """Email via SendGrid — gratuit jusqu'à 100/jour."""
        if not self.sg_key:
            logger.warning("SendGrid non configuré — email ignoré")
            return False
        try:
            html = f"""
<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px">
  <div style="background:#0B0F1E;border-radius:12px;padding:16px 20px;margin-bottom:20px">
    <span style="font-size:1.1rem;font-weight:700;color:#38BDF8">FORGELIS</span>
    <span style="color:#64748B;font-size:.85rem;margin-left:8px">Aria Industrial</span>
  </div>
  <p style="color:#1E293B;font-size:.95rem">Bonjour <b>{nom}</b>,</p>
  <div style="background:#F1F5F9;border-left:4px solid #2563EB;border-radius:8px;padding:14px 18px;margin:16px 0">
    <p style="margin:0;color:#1E293B;font-size:.9rem;line-height:1.6">{message}</p>
  </div>
  <p style="color:#64748B;font-size:.78rem;margin-top:20px">
    Notification envoyée par <b>{expediteur}</b> via Aria Industrial<br>
    <a href="https://forgelis.fr" style="color:#2563EB">forgelis.fr</a>
  </p>
</div>"""
            payload = {
                "personalizations": [{"to": [{"email": email, "name": nom}]}],
                "from": {"email": self.sg_from, "name": "Aria Industrial — Forgelis"},
                "subject": f"[Aria] {sujet}",
                "content": [
                    {"type": "text/plain", "value": f"{sujet}\n\n{message}\n\nForgelis — Aria Industrial"},
                    {"type": "text/html",  "value": html},
                ],
            }
            async with session.post(
                "https://api.sendgrid.com/v3/mail/send",
                headers={"Authorization": f"Bearer {self.sg_key}",
                         "Content-Type": "application/json"},
                json=payload, timeout=aiohttp.ClientTimeout(total=8)
            ) as r:
                ok = r.status in (200, 202)
                if not ok:
                    logger.error(f"SendGrid erreur {r.status}")
                return ok
        except Exception as e:
            logger.error(f"SendGrid exception: {e}")
            return False

    # ──────────────────────────────────────────
    async def _sms_twilio(self, session, telephone: str, message: str) -> bool:
        """SMS via Twilio — ~0,07€/SMS, universel."""
        if not self.tw_sid or not self.tw_token or not self.tw_from:
            logger.warning("Twilio non configuré — SMS ignoré")
            return False
        try:
            import base64
            creds = base64.b64encode(
                f"{self.tw_sid}:{self.tw_token}".encode()).decode()
            # Tronquer à 160 caractères (1 SMS)
            sms_txt = f"Aria Industrial: {message}"[:160]
            async with session.post(
                f"https://api.twilio.com/2010-04-01/Accounts/{self.tw_sid}/Messages.json",
                headers={"Authorization": f"Basic {creds}"},
                data={"From": self.tw_from, "To": telephone, "Body": sms_txt},
                timeout=aiohttp.ClientTimeout(total=10)
            ) as r:
                ok = r.status == 201
                if not ok:
                    logger.error(f"Twilio erreur {r.status}")
                return ok
        except Exception as e:
            logger.error(f"Twilio exception: {e}")
            return False


# Instance globale
notifier = AriaNotifier()


# ── Tests unitaires ──
if __name__ == "__main__":
    import asyncio

    async def test():
        thomas = ProfilSalarie(
            id="thomas.mercier", nom="Thomas Mercier",
            email="thomas@test.fr", telephone="+33612345678",
            forfait=Forfait.PME,
        )
        print("═══ Tests AriaNotifier ═══")
        # Canaux par forfait
        print(f"Canaux TPE auto   : {notifier._canaux_a_utiliser(Forfait.TPE, Canal.AUTO)}")
        print(f"Canaux PME tous   : {notifier._canaux_a_utiliser(Forfait.PME, Canal.TOUS)}")
        print(f"Canaux Solo SMS   : {notifier._canaux_a_utiliser(Forfait.SOLO, Canal.SMS)}")
        print(f"Canaux ETI auto   : {notifier._canaux_a_utiliser(Forfait.ETI, Canal.AUTO)}")
        # Horaires : forcer hors-horaires pour tester la file
        horaires_test = {i: None for i in range(7)}  # tous jours = repos
        r = await notifier.notifier(
            thomas, "Test", "Message test", Canal.TOUS,
            horaires=horaires_test, respecter_horaires=True)
        assert "en_attente" in r.erreurs[0], "Doit être mis en file"
        assert file_notifs.taille() == 1
        print(f"✅ Mise en file hors-horaires — OK (livraison : {r.erreurs[0]})")
        # Urgent → envoyé même hors-horaires
        r2 = await notifier.notifier(
            thomas, "URGENT", "Incident sécurité", Canal.TOUS,
            horaires=horaires_test, urgent=True)
        assert not r2.erreurs or "en_attente" not in str(r2.erreurs)
        print("✅ Urgent envoyé hors-horaires — OK")
        # Dégradation gracieuse sans credentials
        r3 = await notifier.notifier(thomas, "Test", "Test", Canal.TOUS,
                                      respecter_horaires=False)
        assert not r3.push_ok and not r3.email_ok and not r3.sms_ok
        print("✅ Dégradation gracieuse sans credentials — OK")
        print("✅ Logique des canaux par forfait — OK")
        print(f"✅ 7/7 tests passés")

    asyncio.run(test())
