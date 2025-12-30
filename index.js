import "dotenv/config";
import { Client, GatewayIntentBits, EmbedBuilder } from "discord.js";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
  ],
});

// ================== UTILS ==================
let updateTimer = null;

function scheduleUpdate(reason = "unknown") {
  if (updateTimer) clearTimeout(updateTimer);
  updateTimer = setTimeout(async () => {
    updateTimer = null;
    try {
      await upsertVipMessage();
      console.log(`🔄 VIP update (${reason})`);
    } catch (e) {
      console.error("❌ Update failed:", e);
    }
  }, 2000);
}

// ================== EMBED ==================
async function buildVipEmbed(guild) {
  const role = await guild.roles.fetch(process.env.VIP_ROLE_ID);
  const members = role ? [...role.members.values()] : [];

  members.sort((a, b) =>
    a.displayName.localeCompare(b.displayName, "fr")
  );

  const maxShow = 60;
  const lines = members.slice(0, maxShow).map(
    (m) => `• ${m.user} — ${m.displayName}`
  );

  const extra =
    members.length > maxShow
      ? `\n… +${members.length - maxShow} autres`
      : "";

  return new EmbedBuilder()
    .setTitle("👑 Liste des VIP")
    .setDescription(
      `**Total : ${members.length} VIP**\n\n${lines.join("\n")}${extra}`
    )
    .setTimestamp();
}

// ================== MESSAGE ==================
async function upsertVipMessage() {
  const guild = await client.guilds.fetch(process.env.GUILD_ID);
  await guild.members.fetch();

  const channel = await client.channels.fetch(process.env.VIP_CHANNEL_ID);
  if (!channel?.isTextBased()) return;

  const embed = await buildVipEmbed(guild);
  const msgId = process.env.VIP_MESSAGE_ID?.trim();

  if (msgId) {
    const msg = await channel.messages.fetch(msgId);
    await msg.edit({ embeds: [embed] });
  } else {
    const msg = await channel.send({ embeds: [embed] });
    console.log("➡️ Ajoute dans Railway : VIP_MESSAGE_ID=" + msg.id);
  }
}

// ================== EVENTS ==================
client.on("guildMemberUpdate", (oldMember, newMember) => {
  const vip = process.env.VIP_ROLE_ID;
  const before = oldMember.roles.cache.has(vip);
  const after = newMember.roles.cache.has(vip);

  if (before !== after) {
    scheduleUpdate(after ? "VIP added" : "VIP removed");
  }
});

client.on("guildMemberRemove", (member) => {
  if (member.roles?.cache?.has(process.env.VIP_ROLE_ID)) {
    scheduleUpdate("VIP left server");
  }
});

// ================== READY ==================
client.once("ready", async () => {
  console.log(`🤖 Connecté : ${client.user.tag}`);

  await upsertVipMessage();

  // 🔥 SCAN COMPLET TOUTES LES 5 MIN (FIABLE)
  setInterval(async () => {
    console.log("🔎 VIP role scan (periodic)");
    await upsertVipMessage();
  }, 5 * 60 * 1000);
});

client.login(process.env.DISCORD_TOKEN);
