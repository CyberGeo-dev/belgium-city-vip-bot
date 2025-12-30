import "dotenv/config";
import { Client, GatewayIntentBits, EmbedBuilder } from "discord.js";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // nécessaire pour role.members + events
  ],
});

// --- Anti-spam update (debounce) ---
let updateTimer = null;
function scheduleUpdate(reason = "unknown") {
  // regroupe plusieurs changements (ajouts/retraits multiples) en 1 update
  if (updateTimer) clearTimeout(updateTimer);

  updateTimer = setTimeout(async () => {
    updateTimer = null;
    try {
      await upsertVipMessage();
      console.log(`✅ VIP message updated (${reason})`);
    } catch (e) {
      console.error("❌ Update failed:", e?.message || e);
    }
  }, 2000);
}

function mustEnv(name) {
  const v = (process.env[name] || "").trim();
  if (!v) throw new Error(`Variable manquante dans .env / Railway: ${name}`);
  return v;
}

async function buildVipEmbed(guild) {
  const vipRoleId = mustEnv("VIP_ROLE_ID");
  const role = await guild.roles.fetch(vipRoleId);

  const members = role ? [...role.members.values()] : [];
  members.sort((a, b) => a.displayName.localeCompare(b.displayName));

  const maxShow = 60;
  const lines = members
    .slice(0, maxShow)
    .map((m) => `• ${m.user} — ${m.displayName}`);

  const extra =
    members.length > maxShow ? `\n… +${members.length - maxShow} autres` : "";

  return new EmbedBuilder()
    .setTitle("👑 Liste des VIP")
    .setDescription(`**Total : ${members.length} VIP**\n\n${lines.join("\n")}${extra}`)
    .setTimestamp(new Date());
}

async function upsertVipMessage() {
  const guildId = mustEnv("GUILD_ID");
  const vipChannelId = mustEnv("VIP_CHANNEL_ID");

  const guild = await client.guilds.fetch(guildId);

  // s'assure d'avoir les membres (sinon role.members peut être incomplet)
  await guild.members.fetch();

  const channel = await client.channels.fetch(vipChannelId);
  if (!channel?.isTextBased()) throw new Error("VIP_CHANNEL_ID n'est pas un salon texte.");

  const embed = await buildVipEmbed(guild);

  const existingId = (process.env.VIP_MESSAGE_ID || "").trim();
  if (existingId) {
    // si message supprimé / pas accessible => on recrée
    let msg = null;
    try {
      msg = await channel.messages.fetch(existingId);
    } catch {
      msg = null;
    }

    if (msg) {
      await msg.edit({ embeds: [embed] });
    } else {
      const newMsg = await channel.send({ embeds: [embed] });
      console.log("➡️ Mets ceci dans Railway variables : VIP_MESSAGE_ID=" + newMsg.id);
    }
  } else {
    const msg = await channel.send({ embeds: [embed] });
    console.log("➡️ Mets ceci dans Railway variables : VIP_MESSAGE_ID=" + msg.id);
  }
}

// --- Events auto-update ---
client.on("guildMemberUpdate", (oldMember, newMember) => {
  const vipRoleId = (process.env.VIP_ROLE_ID || "").trim();
  if (!vipRoleId) return;

  const hadVip = oldMember.roles.cache.has(vipRoleId);
  const hasVip = newMember.roles.cache.has(vipRoleId);

  if (hadVip !== hasVip) {
    scheduleUpdate(hadVip ? "VIP removed" : "VIP added");
  }
});

// (Optionnel) au cas où un membre quitte : si c'était un VIP, on update
client.on("guildMemberRemove", async (member) => {
  const vipRoleId = (process.env.VIP_ROLE_ID || "").trim();
  if (!vipRoleId) return;

  if (member.roles?.cache?.has(vipRoleId)) {
    scheduleUpdate("VIP left server");
  }
});

// ✅ Discord.js v14+ : utiliser clientReady (au lieu de ready)
client.once("clientReady", async () => {
  console.log(`🤖 Connecté : ${client.user.tag}`);

  // update au démarrage
  await upsertVipMessage();

  // garde un update "sécurité" toutes les 30 min (au cas où)
  setInterval(() => scheduleUpdate("periodic safety"), 30 * 60 * 1000);
});

// Sécurité: log erreurs sinon Railway redémarre en boucle sans info utile
process.on("unhandledRejection", (err) => console.error("unhandledRejection:", err));
process.on("uncaughtException", (err) => console.error("uncaughtException:", err));

client.login(mustEnv("DISCORD_TOKEN"));
