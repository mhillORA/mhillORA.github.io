# Entra for Ora Data Lens — big dummy version

You already made an **Enterprise application**. Fine. That is one half. The website still needs the **App registration** half (client ID, secret, redirect URL).

Do not flip the website login until the two SWA settings are saved. If you flip first, the site will bounce to Microsoft login and break.

Site we are locking:

`https://black-stone-03061770f.7.azurestaticapps.net`

---

## 0. Wrong-page checks

You want a page whose left menu has **Overview, Authentication, Certificates & secrets, Token configuration, API permissions**. That is **App registration**.

If the left menu is **Overview, Users and groups, Properties, Single sign-on, Provisioning** — you are on the **Enterprise application**. That is the other twin. Stay there only for step 5.

If you cannot find an App registration with the same name: you made a SAML/gallery shell. Stop. Go to step 1A and register for real.

---

## 1. Open the App registration

1. Browser: [https://portal.azure.com](https://portal.azure.com)
2. Search bar at the top: type `Entra` → click **Microsoft Entra ID**.
3. Left menu: **App registrations**.
4. Top tabs: click **All applications** (not just “Owned applications”).
5. Find **Ora Data Lens** (or whatever you named it). Click the **name**, not the GUID.

You should now see **Application (client) ID** and **Directory (tenant) ID** at the top. Tenant should be Ora’s:

`2f298692-acc9-4632-b71b-841d51376914`

### 1A. If it is not in App registrations

1. Still in Entra: **App registrations** → **+ New registration**.
2. Name: `Ora Data Lens`
3. Supported account types: **Accounts in this organizational directory only** (single tenant).
4. Redirect URI: leave blank for now. Click **Register**.
5. You now have the Overview page. Continue from step 2.

---

## 2. Copy the client ID

On Overview:

1. Find **Application (client) ID**. It looks like `aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`.
2. Click the copy icon.
3. Paste it into Notepad. Label it `CLIENT ID`.

Do **not** copy Object ID. Do **not** copy Directory (tenant) ID for the SWA setting.

---

## 3. Add the redirect URL (the one SWA actually calls)

1. Left menu: **Authentication**.
2. If you see no platforms yet: **+ Add a platform** → click **Web** (not SPA, not Mobile).
3. Under **Redirect URIs**, paste **exactly** this, one line, no trailing slash:

`https://black-stone-03061770f.7.azurestaticapps.net/.auth/login/aad/callback`

4. Leave **Front-channel logout URL** blank.
5. Leave **Implicit grant** boxes **unchecked**.
6. Click **Configure** (or **Save** if the platform already existed).

If you already had a Web platform: **Add URI** → paste the same URL → **Save**.

---

## 4. Make a client secret

1. Left menu: **Certificates & secrets**.
2. Tab **Client secrets** (not Certificates, not Federated).
3. **+ New client secret**.
4. Description: `data-lens-swa`
5. Expires: 12 months is fine (or 24 if they let you).
6. **Add**.

A new row appears. There are two GUIDs:

- **Value** — long, you need this. Copy it **now**. Paste into Notepad as `SECRET`.
- **Secret ID** — ignore this.

If you click away and the Value is `*****`, you cannot get it back. Delete that secret and make a new one.

---

## 5. Optional: lock who can sign in (Enterprise application)

1. Entra left menu: **Enterprise applications**.
2. Open the same **Ora Data Lens** name.
3. Left: **Properties**.
4. **Assignment required?** → **Yes** → **Save**.
5. Left: **Users and groups** → **+ Add user/group**.
6. Add yourself first so you can test. Add the exec / ClinOps group after it works.

If Assignment required is Yes and you forget to add yourself, you will sign in at Microsoft and then get “you’re not assigned.”

---

## 6. Put the two values on the Static Web App

1. Azure search bar: type `static web` → **Static Web Apps**.
2. Open the one whose URL is `black-stone-03061770f` (Ora Data Lens). Not Bid Workbench.
3. Left menu: **Settings** → **Environment variables**  
   (older portal: **Configuration** → **Application settings**).
4. **+ Add**.

First setting:

- Name: `AZURE_CLIENT_ID`
- Value: the **CLIENT ID** from Notepad
- OK

Second setting:

- Name: `AZURE_CLIENT_SECRET_APP_SETTING_NAME`
- Value: the **SECRET** from Notepad (the Value, not Secret ID)
- OK

5. Click **Save** at the top if the blade has a Save. Wait until it says saved.

Yes, the second **name** is ugly. Copy it exactly. That is what Bid Workbench uses. The **value** is the secret itself.

Do not put these in GitHub. Do not paste them in chat.

---

## 7. Stop and tell me

When both settings show on that SWA (names visible, values hidden), say **settings are saved**.

I will then swap `staticwebapp.config.json` to require login and deploy. Until I do that, the site stays open on purpose.

After deploy, open the site in a private window. You should get the Ora Microsoft login. After login, Ask should still work.

---

## If something looks wrong

| What you see | What it means |
|--------------|----------------|
| No App registration with that name | You made a SAML enterprise app. Do step 1A. |
| Redirect URI rejected | Must be `Web`, not SPA. Must include `/.auth/login/aad/callback`. |
| Secret Value is stars | Make a new secret. |
| Login loop after we flip config | Redirect URI typo, or secret in the wrong setting, or wrong SWA. |
| “User not assigned” | Assignment required is on and your account is not in Users and groups. |
