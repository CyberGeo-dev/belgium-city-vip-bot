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
  if (!v) throw new Error(`Missing env var: ${name}`);
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
  const channelId = mustEnv("VIP_CHANNEL_ID");

  const guild = await client.guilds.fetch(guildId);

  // s'assure d'avoir les membres (sinon role.members peut être incomplet)
  await guild.members.fetch();

  const channel = await client.channels.fetch(channelId);
  if (!channel?.isTextBased()) throw new Error("VIP_CHANNEL_ID n'est pas un salon texte.");

  const embed = await buildVipEmbed(guild);

  const existingId = (process.env.VIP_MESSAGE_ID || "").trim();

  if (existingId) {
    // edit du message existant
    const msg = await channel.messages.fetch(existingId);
    await msg.edit({ embeds: [embed] });
  } else {
    // création du message + on affiche l'ID à mettre dans Railway
    const msg = await channel.send({ embeds: [embed] });
    console.log("➡️ Mets ceci dans tes variables (Railway) : VIP_MESSAGE_ID=" + msg.id);
  }
}

// ✅ Scan “fiable” (au cas où Discord ne déclenche pas guildMemberUpdate)
async function checkVipRoleState(reason = "role scan") {
  try {
    const guildId = mustEnv("GUILD_ID");
    const vipRoleId = mustEnv("VIP_ROLE_ID");

    const guild = await client.guilds.fetch(guildId);
    await guild.members.fetch();

    const role = await guild.roles.fetch(vipRoleId);
    if (!role) {
      console.warn("⚠️ VIP_ROLE_ID introuvable (role fetch null).");
      return;
    }

    console.log(`🔎 VIP role scan (${reason}) — ${role.members.size} membres`);
    scheduleUpdate(reason);
  } catch (e) {
    console.error("❌ VIP role scan failed:", e?.message || e);
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

client.on("guildMemberRemove", (member) => {
  // parfois roles cache indispo sur remove, donc on déclenche juste un update safe
  scheduleUpdate("member left");
});

client.once("ready", async () => {
  console.log(`🤖 Connecté : ${client.user.tag}`);

  // update au démarrage
  await upsertVipMessage();

  // scan de sécurité toutes les 2 minutes (fiable)
  setInterval(() => checkVipRoleState("periodic role scan"), 2 * 60 * 1000);

  // garde un update "sécurité" toutes les 30 min (au cas où)
  setInterval(() => scheduleUpdate("periodic safety"), 30 * 60 * 1000);
});

// ✅ Login
client.login(mustEnv("DISCORD_TOKEN"));
