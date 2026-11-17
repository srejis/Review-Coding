"""Sign in with ChatGPT for local open-source clients."""
import base64
from contextlib import contextmanager
from dataclasses import dataclass
import hashlib
import json
import os
import secrets
import sqlite3
import tempfile
import threading
import time
from urllib.parse import urlencode
import uuid

import httpx
import jwt
import keyring
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

ISSUER = "https://auth.openai.com"
RESOURCE = "https://api.openai.com/v1"
TOKEN = f"{ISSUER}/api/accounts/oauth/token"
DYNAMIC_CLIENT = "dynamic_agent_client"
PLAN_SCOPE = {"resource.invoke", "chatgpt.tokens.use.direct"}
SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"


class ServiceError(RuntimeError):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)


@dataclass
class Attempt:
    verifier: str
    nonce: str
    redirect: str
    client: str
    subject: str | None
    expires: float


class ChatGPTAuth:
    def __init__(self, directory):
        self.directory = directory
        self.path = directory / "session.encrypted"
        self.pending = {}
        self.pending_lock = threading.Lock()
        self.key_id = hashlib.sha256(os.fsencode(str(directory.resolve()))).hexdigest()

    @contextmanager
    def vault(self):
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        # Serialize writes and rotating-token refreshes across CLI and HTTP processes.
        db = sqlite3.connect(self.directory / "auth-lock.sqlite3", timeout=35)
        try:
            db.execute("BEGIN IMMEDIATE")
            key = keyring.get_password("Review-Coding", self.key_id)
            if not key:
                if self.path.exists():
                    raise ServiceError("credential_store", "The credential-store encryption key is unavailable.")
                key = base64.urlsafe_b64encode(AESGCM.generate_key(bit_length=256)).decode()
                keyring.set_password("Review-Coding", self.key_id, key)
            cipher = AESGCM(base64.urlsafe_b64decode(key))
            context = b"Review-Coding ChatGPT session v1"
            if self.path.exists():
                data = self.path.read_bytes()
                record = json.loads(cipher.decrypt(data[:12], data[12:], context))
            else:
                record = dict(host=f"urn:uuid:{uuid.uuid4()}", active=None, profiles={})
            before = json.dumps(record, sort_keys=True)
            yield record
            after = json.dumps(record, sort_keys=True)
            if before != after or not self.path.exists():
                nonce = os.urandom(12)
                with tempfile.NamedTemporaryFile(dir=self.directory, delete=False) as temp:
                    filename = temp.name
                    temp.write(nonce + cipher.encrypt(nonce, after.encode(), context))
                    temp.flush()
                    os.fsync(temp.fileno())
                try:
                    os.replace(filename, self.path)
                finally:
                    if os.path.exists(filename):
                        os.unlink(filename)
            db.commit()
        except keyring.errors.KeyringError as exc:
            raise ServiceError("credential_store", "Enable an OS credential store to connect ChatGPT.") from exc
        finally:
            db.close()

    def status(self):
        if not self.path.exists():
            return dict(auth="signed_out", accounts=[])
        with self.vault() as record:
            active = record["profiles"].get(record["active"], {})
            return dict(auth="chatgpt_plan_oauth" if active.get("access_token") and
                        PLAN_SCOPE <= set(active["scopes"]) else "plan_permission_required",
                        active=record["active"], accounts=[
                            dict(id=client, label=p.get("email") or "ChatGPT")
                            for client, p in record["profiles"].items()])

    def begin(self, redirect, selected=None):
        with self.vault() as record:
            saved = record["profiles"].get(selected)
            if selected and not saved:
                raise ServiceError("account", "Unknown account registration.")
            host = record["host"]
        state = secrets.token_urlsafe(32)
        attempt = Attempt(secrets.token_urlsafe(64), secrets.token_urlsafe(32), redirect,
                          selected or DYNAMIC_CLIENT, saved["subject"] if saved else None,
                          time.monotonic() + 600)
        with self.pending_lock:
            self.pending = {k: v for k, v in self.pending.items() if v.expires > time.monotonic()}
            self.pending[state] = attempt
        challenge = base64.urlsafe_b64encode(hashlib.sha256(attempt.verifier.encode()).digest())
        params = dict(client_id=attempt.client, ext_agent_host_id=host, response_type="code",
                      redirect_uri=redirect, scope=SCOPES, resource=RESOURCE, state=state,
                      nonce=attempt.nonce, code_challenge=challenge.rstrip(b"=").decode(),
                      code_challenge_method="S256")
        if not saved:
            params["agent_name_hint"] = "Review-Coding"
        # Login hints are optional. Keeping them out of the URL avoids handing an ID token to UI code.
        return f"{ISSUER}/api/accounts/authorize?{urlencode(params)}"

    def finish(self, params):
        state = params.get("state", "")
        with self.pending_lock:
            attempt = self.pending.pop(state, None)
        if attempt is None or attempt.expires <= time.monotonic():
            raise ServiceError("oauth_state", "The sign-in request is invalid or expired. Start again.")
        if params.get("error") or not params.get("code"):
            raise ServiceError("authorization_denied", "ChatGPT sign-in or sharing permission was not granted.")
        client = params.get("client_id") or attempt.client
        if (not client.startswith("oaiapp_") or
                (attempt.client != DYNAMIC_CLIENT and client != attempt.client)):
            raise ServiceError("oauth_registration", "The sign-in callback did not match the client registration.")
        tokens = self.exchange(dict(grant_type="authorization_code", client_id=client,
                                    code=params["code"], code_verifier=attempt.verifier,
                                    redirect_uri=attempt.redirect, resource=RESOURCE))
        try:
            token = tokens["id_token"]
            keys = jwt.PyJWKClient(f"{ISSUER}/.well-known/jwks.json", timeout=15)
            claims = jwt.decode(token, keys.get_signing_key_from_jwt(token).key,
                                issuer=ISSUER, audience=client, algorithms=["RS256"],
                                options={"require": ["iss", "aud", "sub", "exp", "nonce"]})
            if not secrets.compare_digest(claims["nonce"], attempt.nonce) or (
                attempt.subject and claims["sub"] != attempt.subject
            ):
                raise ValueError("Identity mismatch")
        except (KeyError, TypeError, ValueError, jwt.PyJWTError) as exc:
            raise ServiceError("oauth_identity", "OpenAI sign-in identity verification failed.") from exc
        with self.vault() as record:
            record["profiles"][client] = self.updated_tokens(
                dict(subject=claims["sub"], email=claims.get("email")), tokens)
            record["active"] = client

    @staticmethod
    def exchange(form):
        try:
            response = httpx.post(TOKEN, data=form, timeout=20)
        except httpx.RequestError as exc:
            raise ServiceError("network", "Could not reach OpenAI sign-in.") from exc
        if not response.is_success:
            raise ServiceError("oauth_exchange", f"OpenAI sign-in exchange failed (HTTP {response.status_code}).")
        return response.json()

    @staticmethod
    def updated_tokens(previous, tokens):
        if (not tokens.get("access_token") or str(tokens.get("token_type", "")).lower() != "bearer"):
            raise ServiceError("oauth_token", "OpenAI did not return a usable OAuth access token.")
        return {**previous, **{k: tokens[k] for k in ("access_token", "refresh_token", "id_token") if k in tokens},
                "scopes": tokens["scope"].split() if "scope" in tokens else previous.get("scopes", []),
                "expires_at": time.time() + int(tokens["expires_in"])}

    def token(self, selected=None):
        if not self.path.exists():
            raise ServiceError("signed_out", "Continue with ChatGPT to authorize plan usage.")
        with self.vault() as record:
            client = selected or record["active"]
            profile = record["profiles"].get(client, {})
            if not profile or not PLAN_SCOPE <= set(profile["scopes"]):
                raise ServiceError("plan_permission", "This ChatGPT registration has not granted plan usage.")
            if profile["expires_at"] <= time.time() + 20:
                if not profile.get("refresh_token"):
                    raise ServiceError("session_expired", "Sign in to ChatGPT again.")
                response = self.exchange(dict(grant_type="refresh_token", client_id=client,
                                              refresh_token=profile["refresh_token"], resource=RESOURCE))
                profile = self.updated_tokens(profile, response)
                if not response.get("refresh_token"):
                    raise ServiceError("refresh_token", "OpenAI did not rotate the renewable session. Sign in again.")
                record["profiles"][client] = profile
            if not PLAN_SCOPE <= set(profile["scopes"]):
                raise ServiceError("plan_permission", "ChatGPT plan usage is no longer granted.")
            return profile["access_token"]
