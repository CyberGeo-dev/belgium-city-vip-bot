import "dotenv/config";
import { Client, GatewayIntentBits, EmbedBuilder, Partials, DiscordAPIError } from "discord.js";

const env = (k) => (process.env[k] || "").trim();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.GuildMember],
});

// --------------------
// Anti-spam + anti-rate-limit
// --------------------
let updateTimer = null;
let isUpdating = false;
let blockedUntil = 0;

function scheduleUpdate(reason = "unknown") {
  if (updateTimer) clearTimeout(updateTimer);

  // debounce court = quasi instantané
  updateTimer = setTimeout(async () => {
    updateTimer = null;

    const now = Date.now();
    if (now < blockedUntil) {
      console.log(`⏳ Update blocked (${Math.ceil((blockedUntil - now) / 1000)}s left)`);
      return;
    }

    if (isUpdating) {
      // si un update est déjà en cours, on laisse le prochain interval/event relancer
      console.log("⏳ Update skipped (already running)");
      return;
    }

    isUpdating = true;
    try {
      await upsertVipMessage();
      console.log(`✅ VIP message updated (${reason})`);
    } catch (e) {
      const msg = e?.message || String(e);

      // Si on se fait rate-limit (ou message opcode rate limited), on bloque un peu
      const m = msg.match(/Retry after ([0-9.]+) seconds/i);
      if (m) {
        const seconds = Number(m[1]);
        blockedUntil = Date.now() + Math.ceil(seconds * 1000) + 1500; // marge
        console.warn(`🚦 Rate limited: waiting ${seconds}s`);
      } else {
        console.error("❌ Update failed:", msg);
      }
    } finally {
      isUpdating = false;
    }
  }, 800); // 0.8s = rapide mais regroupe les changements
}

// --------------------
// Build embed
// --------------------
async function buildVipEmbed(guild) {
  const vipRoleId = env("VIP_ROLE_ID");
  const role = await guild.roles.fetch(vipRoleId).catch(() => null);

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

// --------------------
// Create or edit message safely
// --------------------
async function upsertVipMessage() {
  const guildId = env("GUILD_ID");
  const channelId = env("VIP_CHANNEL_ID");
  const messageId = env("VIP_MESSAGE_ID");

  if (!guildId || !channelId) throw new Error("❌ GUILD_ID / VIP_CHANNEL_ID manquant.");

  const guild = await client.guilds.fetch(guildId);

  // ⚠️ IMPORTANT: garder le cache membre à jour pour role.members
  // (on évite de le faire trop souvent -> seulement quand on update)
  await guild.members.fetch();

  const channel = await client.channels.fetch(channelId);
  if (!channel?.isTextBased()) throw new Error("VIP_CHANNEL_ID n'est pas un salon texte.");

  const embed = await buildVipEmbed(guild);

  // Si on a un message id -> on tente edit
  if (messageId) {
    try {
      const msg = await channel.messages.fetch(messageId);
      await msg.edit({ embeds: [embed] });
      return;
    } catch (e) {
      // 10008 = Unknown Message (supprimé / mauvais ID)
      // 50001 = Missing Access
      const code = e?.code;
      if (code === 10008) {
        console.warn("⚠️ VIP_MESSAGE_ID invalide / message supprimé. Je recrée un message...");
      } else if (code === 50001) {
        throw new Error("❌ Missing Access: le bot n’a pas accès à ce salon (permissions/overwrites).");
      } else {
        // autre erreur -> on remonte
        throw e;
      }
    }
  }

  // Sinon (ou si l'ID était mort) -> on recrée 1 message
  const msg = await channel.send({ embeds: [embed] });
  console.log("➡️ Mets ceci dans Railway Variables : VIP_MESSAGE_ID=" + msg.id);
}

// --------------------
// Events (instantané)
// --------------------
client.on("guildMemberUpdate", async (oldMember, newMember) => {
  const vip = env("VIP_ROLE_ID");
  if (!vip) return;

  // sécurise partials
  if (oldMember.partial) {
    try { oldMember = await oldMember.fetch(); } catch {}
  }
  if (newMember.partial) {
    try { newMember = await newMember.fetch(); } catch {}
  }

  const before = oldMember.roles.cache.has(vip);
  const after = newMember.roles.cache.has(vip);

  if (before !== after) {
    console.log(`👀 guildMemberUpdate: ${newMember.user.tag} before=${before} after=${after}`);
    scheduleUpdate(after ? "VIP added" : "VIP removed");
  }
});

client.on("guildMemberRemove", (member) => {
  const vip = env("VIP_ROLE_ID");
  if (member.roles?.cache?.has(vip)) {
    scheduleUpdate("VIP left server");
  }
});

// Evite crash sur erreurs non catch (super important sur Railway)
client.on("error", (err) => console.error("❌ Client error:", err));
process.on("unhandledRejection", (reason) => console.error("❌ UnhandledRejection:", reason));

// --------------------
// Ready
// --------------------
client.once("ready", async () => {
  console.log(`🤖 Connecté : ${client.user.tag}`);

  // update au démarrage
  scheduleUpdate("startup");

  // Safety scan (PAS 30s) sinon rate limit.
  // 5 minutes = assez pour rattraper si un event est raté.
  setInterval(() => scheduleUpdate("periodic safety"), 5 * 60 * 1000);
});

client.login(env("DISCORD_TOKEN"));
