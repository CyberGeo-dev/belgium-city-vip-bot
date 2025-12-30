import "dotenv/config";
import { Client, GatewayIntentBits, EmbedBuilder, Partials } from "discord.js";

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.GuildMember],
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
  }, 1500);
}

async function buildVipEmbed(guild) {
  const vipRoleId = (process.env.VIP_ROLE_ID || "").trim();
  const role = await guild.roles.fetch(vipRoleId);

  const members = role ? [...role.members.values()] : [];
  members.sort((a, b) => a.displayName.localeCompare(b.displayName));

  const maxShow = 60;
  const lines = members.slice(0, maxShow).map((m) => `• ${m.user} — ${m.displayName}`);
  const extra = members.length > maxShow ? `\n… +${members.length - maxShow} autres` : "";

  return new EmbedBuilder()
    .setTitle("👑 Liste des VIP")
    .setDescription(`**Total : ${members.length} VIP**\n\n${lines.join("\n")}${extra}`)
    .setTimestamp(new Date());
}

async function upsertVipMessage() {
  const guildId = (process.env.GUILD_ID || "").trim();
  const channelId = (process.env.VIP_CHANNEL_ID || "").trim();
  const messageId = (process.env.VIP_MESSAGE_ID || "").trim();

  const guild = await client.guilds.fetch(guildId);

  // ⚠️ Important : remplis le cache membres (sinon role.members peut être incomplet)
  await guild.members.fetch();

  const channel = await client.channels.fetch(channelId);
  if (!channel?.isTextBased()) throw new Error("VIP_CHANNEL_ID n'est pas un salon texte.");

  const embed = await buildVipEmbed(guild);

  if (messageId) {
    const msg = await channel.messages.fetch(messageId);
    await msg.edit({ embeds: [embed] });
  } else {
    const msg = await channel.send({ embeds: [embed] });
    console.log("➡️ Mets ceci dans Railway Variables : VIP_MESSAGE_ID=" + msg.id);
  }
}

// --- Events auto-update ---
client.on("guildMemberUpdate", async (oldMember, newMember) => {
  const vip = (process.env.VIP_ROLE_ID || "").trim();

  // si oldMember est partial, on fetch pour fiabiliser
  if (oldMember.partial) {
    try {
      oldMember = await oldMember.fetch();
    } catch {}
  }
  if (newMember.partial) {
    try {
      newMember = await newMember.fetch();
    } catch {}
  }

  const before = oldMember.roles.cache.has(vip);
  const after = newMember.roles.cache.has(vip);

  console.log(`👀 guildMemberUpdate: ${newMember.user.tag} before=${before} after=${after}`);

  if (before !== after) {
    scheduleUpdate(after ? "VIP added" : "VIP removed");
  }
});

client.on("guildMemberRemove", (member) => {
  const vip = (process.env.VIP_ROLE_ID || "").trim();
  if (member.roles?.cache?.has(vip)) {
    scheduleUpdate("VIP left server");
  }
});

client.once("ready", async () => {
  console.log(`🤖 Connecté : ${client.user.tag}`);

  await upsertVipMessage();

  // 🔥 secours : scan toutes les 30 secondes (Railway)
  setInterval(() => scheduleUpdate("periodic safety"), 30 * 1000);
});

client.login((process.env.DISCORD_TOKEN || "").trim());
