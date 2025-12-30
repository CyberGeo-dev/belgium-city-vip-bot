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

async function buildVipEmbed(guild) {
  const role = await guild.roles.fetch(process.env.VIP_ROLE_ID);
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
  const guild = await client.guilds.fetch(process.env.GUILD_ID);

  // s'assure d'avoir les membres (sinon role.members peut être incomplet)
  await guild.members.fetch();

  const channel = await client.channels.fetch(process.env.VIP_CHANNEL_ID);
  if (!channel?.isTextBased()) throw new Error("VIP_CHANNEL_ID n'est pas un salon texte.");

  const embed = await buildVipEmbed(guild);

  const existingId = (process.env.VIP_MESSAGE_ID || "").trim();
  if (existingId) {
    const msg = await channel.messages.fetch(existingId);
    await msg.edit({ embeds: [embed] });
  } else {
    const msg = await channel.send({ embeds: [embed] });
    console.log("➡️ Mets ceci dans .env : VIP_MESSAGE_ID=" + msg.id);
  }
}

// --- Events auto-update ---
client.on("guildMemberUpdate", (oldMember, newMember) => {
  const vipRoleId = process.env.VIP_ROLE_ID;

  const hadVip = oldMember.roles.cache.has(vipRoleId);
  const hasVip = newMember.roles.cache.has(vipRoleId);

  if (hadVip !== hasVip) {
    scheduleUpdate(hadVip ? "VIP removed" : "VIP added");
  }
});

// (Optionnel) au cas où un membre quitte : si c'était un VIP, on update
client.on("guildMemberRemove", async (member) => {
  if (member.roles?.cache?.has(process.env.VIP_ROLE_ID)) {
    scheduleUpdate("VIP left server");
  }
});

client.once("ready", async () => {
  console.log(`🤖 Connecté : ${client.user.tag}`);

  // update au démarrage
  await upsertVipMessage();

  // garde un update "sécurité" toutes les 30 min (au cas où)
  setInterval(() => scheduleUpdate("periodic safety"), 30 * 60 * 1000);
});

client.login(process.env.DISCORD_TOKEN);
