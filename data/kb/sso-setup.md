---
title: Single sign-on (SAML and OIDC)
tags: sso, okta, saml, oidc, login
updated: 2026-09-16
trust: internal
---

# Single sign-on (SAML and OIDC)

Kestrel Cloud supports SAML 2.0 and OpenID Connect with Okta, Microsoft Entra ID and Google Workspace on Growth and Enterprise plans.

## Login loop after signing in

Usually the ACS URL or the audience in the identity provider does not match. Check that the ACS URL ends with `/sso/saml/acs` and that the clock of the identity provider is correct. Clearing cookies for kestrel.example also helps after a configuration change.
