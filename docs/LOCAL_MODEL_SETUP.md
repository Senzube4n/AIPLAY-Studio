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
3. Create a [Hugging Face read token](https://huggingface.co/settings/tokens)
   and connect it in Studio. Write permission is not needed. A fine-grained
   token must allow reading this gated repository after your account has access.
   If Studio already has a usable token, the card identifies it before reuse.
4. Press **Check access**, confirm **Publisher terms accepted**, then press
   **Install LTX**. Check the displayed download size, destination and free space.

Studio checks access to the pinned files, downloads them from the publisher,
resumes partial files and verifies their size and SHA-256 before marking them
ready. Cancel stops the transfer; installing again resumes the partial files.
You do not need to find ComfyUI's Python environment or run a download script.

The token is shared with Studio's Hugging Face model browser. The card shows
how it is stored: normally Windows DPAPI on Windows, otherwise file permissions.
The fallback protected by file permissions is not encryption. The token is
not returned to the browser or stored in project files. **Forget token** removes
it from Studio. Studio does not import another program's Hugging Face login.

## If access fails

- **Not connected:** connect a read token, or replace an unusable saved token.
- **Access required:** open the model page using the account that owns the
  token, approve the terms, and check again. Some approvals depend on the publisher.
- **Token rejected:** replace the token and check its read permissions.
- **Not enough space:** free space or change Studio's model folder before installing.
- **Connection interrupted:** check the connection and press Install again to resume.
  A verification failure does not mark an incomplete file as ready.

For advanced source-install troubleshooting, see [INSTALL.md](../INSTALL.md).
The developer download script remains available; it is not the normal setup path.
