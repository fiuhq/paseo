# Workfloor provider

A Paseo provider whose agents are your private Workfloor conversations. Pick one of a project's
agents as the model (`Buildy · codev`); the first message starts a conversation with it in
Workfloor, and every later message goes to that conversation's agent. Paseo's session list shows
your conversations, so you can open one you started in Workfloor.

A card on an assembly lane opens the same way: paste its Workfloor link (the long one, or the
short `/c/<card>` one Copy link gives) into Import's search, and the card is listed to open. The
agent takes the card's name, its history replays, your messages go to the agent of the stage it is
on now (the next stage's agent, once the lane moves it on), and the agent's questions are asked in
Paseo. A card whose stage has no agent yet starts one with your message, as Workfloor's Start agent
does, if you are its assignee or a project admin; send words first, pictures after. The lane still
moves the card; a stage's go and an approval stay Workfloor's.
While the card is open in Paseo, its lane is followed between your messages too: when the card
moves to another stage, Paseo shows that stage's agent, says the card moved on, and follows what it
writes. A message you write on Workfloor's page shows in Paseo too.

Pictures go both ways. One you attach in Paseo is uploaded to the card's current session and sent
with your message (a new conversation takes pictures from its second message, as Workfloor does);
one an agent's message carries in Workfloor shows under its words in Paseo, or as a link to the card
when Workfloor can't give it back. A person's message replays with a note and a link to the card
in place of its pictures.

Connect it in Paseo's Settings, Workfloor: Workfloor's address and a personal token that can read
and write (Workfloor: Settings, Personal tokens). The token stays on this host, in the plugin's
settings.

It talks to Workfloor as you, through the routes Workfloor's own page uses
(`/api/conversations`, `/api/conversation`, `/api/events`, `/api/lane-flows/questions`,
`/api/lane-flows/agent-start`, `/api/attachments`); Workfloor lets a token that writes reach them,
audits each write as made by a token, and refuses it a go on a gate or a permission. So:

- the agent's question is asked in Paseo, while the turn stays open: pick an option, write your own
  answer, or decline it; one you answer in Workfloor meanwhile is withdrawn here;
- a plan step's go, an approval, a handoff or issue the agent offers, and a permission request are
  answered in Workfloor: the turn ends with a link to the card;
- the agent works in Workfloor, on its project's repositories, not in your Paseo workspace;
- a conversation keeps the agent it started with.

Check it as [every fiu plugin](../README.md) that draws in the app.
