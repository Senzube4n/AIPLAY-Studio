# Install local models

For a normal Windows installation, run **Setup.exe**, choose **Full Studio**
and your hardware, then let the launcher install the engine. Open **Models**
in Studio and choose the features you want. You do not need a terminal or a
Hugging Face account for the standard, public model downloads.

Every model is optional except the music engine for making songs. Choosing an
optional model does not make it a required part of installing Studio. Files
download only when you ask, into the model folders configured in Studio.

## Optional LTX 2.5

LTX 2.5 requires a Hugging Face account and the publisher's approval. You can
skip it and use the rest of Studio, including another installed video engine.

1. Open **Models → Set up LTX**.
2. Use **Open model page** to sign in to Hugging Face and accept the
   [publisher's access terms](https://huggingface.co/Lightricks/LTX-2.5).
   Studio cannot accept those terms or grant access for you.
3. Press **Sign in with Hugging Face**. In the sign-in window, authorize Studio
   to read gated models that your account can access. Studio then checks the
   pinned LTX files. Allow pop-ups for Studio if the window is blocked.
4. Once access is ready, confirm **Publisher terms accepted**, then press
   **Install LTX**. Check the displayed download size, destination and free space.

Signing in does not accept the publisher's terms or start a download. **Cancel
sign-in** stops a pending login; closing the sign-in window alone lets Studio
continue checking its saved status. If the login expires, sign in again.
**Check access** repeats the file-access check when you need it.

Studio checks access to the pinned files, downloads them from the publisher,
resumes partial files and verifies their size and SHA-256 before marking them
ready. Cancel stops the transfer; installing again resumes the partial files.
You do not need to find ComfyUI's Python environment or run a download script.

Browser sign-in is used for gated-model setup. The **Storage** disclosure
reports its protection: normally Windows DPAPI on Windows,
otherwise file permissions. The file-permissions fallback is not encryption.
OAuth credentials stay on Studio's server and are not returned to its browser
interface or stored in project files. **Disconnect** removes the saved browser
login from Studio. Studio does not import another program's Hugging Face login.

### Advanced: use a read token

If browser sign-in is unavailable, expand **Use a read token**, create a
[Hugging Face read token](https://huggingface.co/settings/tokens), and press
**Connect token**. Write permission is not needed. A fine-grained token must
allow reading the gated Lightricks/LTX-2.5 repository after your account has
access. The input clears when submitted; Studio does not return the saved token
to the interface. This manual token is shared with Studio's Hugging Face model
browser. **Forget token** removes it from Studio.

## If access fails

- **Not connected:** sign in with Hugging Face, or use the read-token fallback.
- **Access required:** open the model page using the account that owns the
  saved connection, approve the terms, and check again. Some approvals depend on the publisher.
- **Sign-in expired or declined:** sign in again and authorize gated-model access.
- **Token rejected:** replace the token and check its read permissions.
- **Not enough space:** free space or change Studio's model folder before installing.
- **Connection interrupted:** check the connection and press Install again to resume.
  A verification failure does not mark an incomplete file as ready.

For advanced source-install troubleshooting, see [INSTALL.md](../INSTALL.md).
The developer download script remains available; it is not the normal setup path.
