# What Freedom Agent can see

AI features are off by default. You choose whether to enable them and which model
provider to connect in **Settings → AI**.

## Pages you share

Agent can read the tab attached to its conversation and tabs it opens for that
conversation, until you take control of them. A new chat normally attaches your current page; you can remove it
before sending. Other open tabs are not automatically shared, and private windows
are unavailable to Agent.

Agent’s tabs use the browser’s existing website logins. If Agent opens your
signed-in webmail, it can read the inbox that website shows. Sharing a page can
therefore share personal information even if you did not type it into the chat.

Page-reading tools do not expose your browsing history, bookmarks, saved-password
store, raw cookies, wallet private keys or seed phrase. Website cookies still
keep Agent signed in. Project commands have different access, described below.
Anything you paste or attach becomes part of the conversation.

## Files, projects and connected services

Agent can read attached files, edit an editable project and create its own
workspace. Read-only projects cannot run commands. Commands run in Freedom’s
platform sandbox; they are refused if protection is unavailable.

On macOS and Linux, command file access is scoped, but commands can request
internet and local-network access. In **Ask when needed**, an AI reviewer can
approve that access without asking you. On Windows, commands require full-network
approval and can read files outside the project that the sandbox account can
access; their write access remains restricted. Do not treat the Windows sandbox
as a boundary that keeps all other readable files private.

Connected services add their own capabilities. A service may expose documents,
messages or actions from its account. Connecting one is separate from choosing a
model provider. Each service call needs approval and can share information with
that service.

## Who receives the information

The selected model provider receives prompts, conversation context, attachments
and the page/file/tool results sent to it. Helpers, permission checks and context
management use that conversation’s model too. Dictation can use another connected
provider, as explained below.

A local server such as Ollama receives requests at its configured address. That
address alone does not prove the server stays offline or never forwards data.
Cloud providers handle information under their own policies. The conversation’s
privacy shield shows the endpoint Freedom contacted, encryption coverage and
checks performed after requests start. It cannot identify every upstream service
or observe the Claude CLI’s own traffic. Provider claims are not independent proof.

Cloud dictation sends recorded audio to its service. Without a saved choice, the
first recording uses your chat provider if supported, otherwise another connected
API service; the microphone tooltip names it. Use its chevron to choose.
**On this device** transcribes locally after a model download. Dictated text goes
to your chat provider when you send the prompt.

## Approvals and storage

Your permission mode controls when Agent asks before website interactions and
project changes. Reading a shared page or navigating does not normally ask each
time. With optional Markdown reading (#1128), Agent can also request a site’s
Markdown version separately: up to two same-site requests without cookies.
In **Fewer interruptions**, website clicks and form submissions can proceed
without asking, including sending a message or placing an order while signed in.
In **Ask when needed**, standard HTML form submissions ask. An AI classifier can
approve other clicks and typing, which on some sites includes buttons that send
messages or place orders. Uploads, downloads, page tools and site dialogs always
ask. Diagnostics you agree to share can include recently visited site addresses.

Built-in wallet transactions and signatures, domain purchases and public Swarm
publishing have their own explicit approval flows. Publishing makes the selected
content public; model privacy settings do not make a website or service action
private.

Chats and attachments are stored in this browser profile. Downloads and project
changes also remain in their own folders; deleting a chat does not remove them.
The Claude CLI may retain its own diagnostics. Removing local history does not
delete provider or service copies, and stopping a task cannot undo completed actions.
