import "dotenv/config";
import fs from "fs";
import path from "path";
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
} from "discord.js";

// ===================== ENV =====================
const ENV = {
  DISCORD_TOKEN: (process.env.DISCORD_TOKEN || "").trim(),
  CLIENT_ID: (process.env.CLIENT_ID || "").trim(),
  GUILD_ID: (process.env.GUILD_ID || "").trim(),
  VIP_ROLE_ID: (process.env.VIP_ROLE_ID || "").trim(),
  VIP_CHANNEL_ID: (process.env.VIP_CHANNEL_ID || "").trim(),
  VIP_MESSAGE_ID: (process.env.VIP_MESSAGE_ID || "").trim(), // peut être vide
  STAFF_ALERT_CHANNEL_ID: (process.env.STAFF_ALERT_CHANNEL_ID || "").trim(),
};

function must(name) {
  const v = ENV[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

must("DISCORD_TOKEN");
must("CLIENT_ID");
must("GUILD_ID");
must("VIP_ROLE_ID");
must("VIP_CHANNEL_ID");
must("STAFF_ALERT_CHANNEL_ID");

// ===================== DATA STORE (JSON) =====================
// ⚠️ Sur Railway, ce fichier peut être perdu lors de certains redeploys.
// Pour du "vrai" permanent, on migrera vers SQLite + volume ou DB.
const DATA_DIR = path.join(process.cwd(), "data");
const VIP_DB_FILE = path.join(DATA_DIR, "vip.json");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(VIP_DB_FILE)) fs.writeFileSync(VIP_DB_FILE, JSON.stringify({}, null, 2));
}

function loadVipDb() {
  ensureDataDir();
  try {
    return JSON.parse(fs.readFileSync(VIP_DB_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveVipDb(db) {
  ensureDataDir();
  fs.writeFileSync(VIP_DB_FILE, JSON.stringify(db, null, 2));
}

// structure:
// db[userId] = {
//   permanent: boolean,
//   expiresAt: string|null,
//   note: string,
//   alerts: { d7?: true, d3?: true, d1?: true, expired?: true },
//   updatedAt: string
// }

// ===================== CLIENT =====================
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.GuildMember],
});

// ===================== SAFE ERROR HANDLING =====================
client.on("error", (e) => console.error("Client error:", e));
process.on("unhandledRejection", (e) => console.error("UnhandledRejection:", e));
process.on("uncaughtException", (e) => console.error("UncaughtException:", e));

// ===================== VIP LIST MESSAGE (ONE MESSAGE, NO DUPES) =====================
let updateTimer = null;
let isUpdating = false;
let blockedUntil = 0;

function scheduleVipListUpdate(reason = "unknown") {
  if (updateTimer) clearTimeout(updateTimer);

  updateTimer = setTimeout(async () => {
    const now = Date.now();
    if (now < blockedUntil) return;

    if (isUpdating) return;
    isUpdating = true;

    try {
      await upsertVipListMessage();
      console.log(`✅ VIP list updated (${reason})`);
    } catch (e) {
      const msg = e?.message || String(e);

      // rate limit backoff (websocket opcode 8 etc.)
      const m = msg.match(/Retry after\s+([0-9.]+)\s*seconds?/i);
      if (m) {
        const sec = parseFloat(m[1]);
        blockedUntil = Date.now() + Math.ceil(sec * 1000) + 1500;
        console.warn(`🚦 Rate limited: waiting ${sec}s`);
      } else {
        console.error("❌ VIP list update failed:", msg);
      }
    } finally {
      isUpdating = false;
    }
  }, 700); // quasi instantané
}

async function buildVipListEmbed(guild) {
  const role = await guild.roles.fetch(ENV.VIP_ROLE_ID).catch(() => null);
  const members = role ? [...role.members.values()] : [];
  members.sort((a, b) => a.displayName.localeCompare(b.displayName, "fr"));

  const maxShow = 60;
  const lines = members.slice(0, maxShow).map((m) => `• ${m.user} — ${m.displayName}`);
  const extra = members.length > maxShow ? `\n… +${members.length - maxShow} autres` : "";

  return new EmbedBuilder()
    .setTitle("👑 Liste des VIP")
    .setDescription(`**Total : ${members.length} VIP**\n\n${lines.join("\n")}${extra}`)
    .setTimestamp(new Date());
}

async function upsertVipListMessage() {
  const guild = await client.guilds.fetch(ENV.GUILD_ID);
  await guild.members.fetch(); // pour role.members correct

  const channel = await client.channels.fetch(ENV.VIP_CHANNEL_ID);
  if (!channel?.isTextBased()) throw new Error("VIP_CHANNEL_ID n'est pas un salon texte.");

  const embed = await buildVipListEmbed(guild);

  const messageId = (ENV.VIP_MESSAGE_ID || "").trim();

  if (messageId) {
    try {
      const msg = await channel.messages.fetch(messageId);
      await msg.edit({ embeds: [embed] });
      return;
    } catch (e) {
      if (e?.code === 10008) {
        console.warn("⚠️ VIP_MESSAGE_ID invalide (message supprimé) → recréation…");
        ENV.VIP_MESSAGE_ID = "";
      } else if (e?.code === 50001) {
        throw new Error("Missing Access: le bot n'a pas accès au salon VIP (permissions).");
      } else {
        throw e;
      }
    }
  }

  const msg = await channel.send({ embeds: [embed] });
  ENV.VIP_MESSAGE_ID = msg.id;
  console.log("➡️ Mets ceci dans Railway Variables : VIP_MESSAGE_ID=" + msg.id);
}

// ===================== ALERTS & EXPIRATIONS =====================
function addDays(baseDate, days) {
  const d = new Date(baseDate);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function nowIso() {
  return new Date().toISOString();
}

async function sendStaffAlert(text) {
  try {
    const ch = await client.channels.fetch(ENV.STAFF_ALERT_CHANNEL_ID);
    if (ch?.isTextBased()) {
      await ch.send({ content: text });
    } else {
      console.log("[STAFF ALERT]", text);
    }
  } catch (e) {
    console.log("[STAFF ALERT FAILED]", text, e?.message || e);
  }
}

async function checkVipExpirations() {
  const db = loadVipDb();
  const guild = await client.guilds.fetch(ENV.GUILD_ID);

  const roleId = ENV.VIP_ROLE_ID;
  const now = Date.now();

  const thresholds = [
    { key: "d7", ms: 7 * 24 * 60 * 60 * 1000, label: "dans 7 jours" },
    { key: "d3", ms: 3 * 24 * 60 * 60 * 1000, label: "dans 3 jours" },
    { key: "d1", ms: 1 * 24 * 60 * 60 * 1000, label: "dans 1 jour" },
  ];

  let changed = false;

  for (const [userId, info] of Object.entries(db)) {
    info.alerts = info.alerts || {};

    if (info.permanent) continue;
    if (!info.expiresAt) continue;

    const exp = new Date(info.expiresAt).getTime();
    const remaining = exp - now;

    // alerts before expiry
    for (const t of thresholds) {
      if (!info.alerts[t.key] && remaining <= t.ms && remaining > 0) {
        info.alerts[t.key] = true;
        changed = true;

        await sendStaffAlert(
          `⏰ **Alerte VIP**: <@${userId}> expire **${t.label}** (expiration: <t:${Math.floor(exp / 1000)}:F>).`
        );
      }
    }

    // expired
    if (remaining <= 0 && !info.alerts.expired) {
      info.alerts.expired = true;
      changed = true;

      // remove role if member exists
      try {
        const member = await guild.members.fetch(userId);
        if (member.roles.cache.has(roleId)) {
          await member.roles.remove(roleId, "VIP expired");
        }
        await sendStaffAlert(
          `❌ **VIP expiré**: <@${userId}> vient d’expirer (expiration: <t:${Math.floor(exp / 1000)}:F>). Rôle retiré automatiquement.`
        );
      } catch {
        await sendStaffAlert(
          `❌ **VIP expiré**: <@${userId}> a expiré (expiration: <t:${Math.floor(exp / 1000)}:F>). (Membre introuvable ou rôle déjà retiré)`
        );
      }

      // Option: on peut supprimer l'entrée après expiration
      // Ici on la garde avec flags pour historique.
    }
  }

  if (changed) saveVipDb(db);

  // keep list message synced too
  scheduleVipListUpdate("expiry check");
}

// ===================== VIP MGMT HELPERS =====================
function isAdminInteraction(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ||
         interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
}

async function addOrExtendVip(userId, days, note = "") {
  const db = loadVipDb();
  const info = db[userId] || {
    permanent: false,
    expiresAt: null,
    note: "",
    alerts: {},
    updatedAt: nowIso(),
  };

  if (info.permanent) {
    // si permanent, on ne change pas l'expiration
    info.updatedAt = nowIso();
    if (note) info.note = note;
    db[userId] = info;
    saveVipDb(db);
    return { mode: "permanent", expiresAt: null };
  }

  const base = info.expiresAt ? new Date(info.expiresAt) : new Date();
  const baseTime = base.getTime();
  const now = Date.now();

  const start = baseTime > now ? base : new Date(); // si pas expiré -> prolonge, sinon -> repart de maintenant
  const newExp = addDays(start, days);

  info.permanent = false;
  info.expiresAt = newExp.toISOString();
  info.note = note || info.note || "";
  info.alerts = {}; // reset alerts quand on prolonge
  info.updatedAt = nowIso();

  db[userId] = info;
  saveVipDb(db);

  return { mode: "temporary", expiresAt: info.expiresAt };
}

async function setPermanentVip(userId, note = "") {
  const db = loadVipDb();
  db[userId] = {
    permanent: true,
    expiresAt: null,
    note: note || "VIP permanent",
    alerts: {},
    updatedAt: nowIso(),
  };
  saveVipDb(db);
}

async function removeVipRecord(userId) {
  const db = loadVipDb();
  delete db[userId];
  saveVipDb(db);
}

// ===================== SLASH COMMANDS =====================
const commands = [
  new SlashCommandBuilder()
    .setName("vip_add")
    .setDescription("Ajoute / prolonge un VIP (en jours, ex: 30 = 1 mois).")
    .addUserOption(o => o.setName("joueur").setDescription("Le joueur").setRequired(true))
    .addIntegerOption(o => o.setName("jours").setDescription("Nombre de jours (ex: 30, 60, 90)").setRequired(true))
    .addStringOption(o => o.setName("note").setDescription("Note interne").setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName("vip_perm")
    .setDescription("Met un VIP permanent.")
    .addUserOption(o => o.setName("joueur").setDescription("Le joueur").setRequired(true))
    .addStringOption(o => o.setName("note").setDescription("Note interne").setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName("vip_remove")
    .setDescription("Retire le rôle VIP et supprime l'enregistrement.")
    .addUserOption(o => o.setName("joueur").setDescription("Le joueur").setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName("vip_info")
    .setDescription("Affiche les infos VIP d'un joueur.")
    .addUserOption(o => o.setName("joueur").setDescription("Le joueur").setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName("vip_refresh")
    .setDescription("Force la mise à jour de la liste VIP.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
].map(c => c.toJSON());

async function registerGuildCommands() {
  const rest = new REST({ version: "10" }).setToken(ENV.DISCORD_TOKEN);
  await rest.put(
    Routes.applicationGuildCommands(ENV.CLIENT_ID, ENV.GUILD_ID),
    { body: commands }
  );
  console.log("✅ Slash commands registered (guild).");
}

// ===================== INTERACTIONS =====================
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (!isAdminInteraction(interaction)) {
    return interaction.reply({ content: "❌ Tu n'as pas la permission.", ephemeral: true });
  }

  const guild = await client.guilds.fetch(ENV.GUILD_ID);
  const vipRole = await guild.roles.fetch(ENV.VIP_ROLE_ID);

  try {
    if (interaction.commandName === "vip_add") {
      const user = interaction.options.getUser("joueur", true);
      const days = interaction.options.getInteger("jours", true);
      const note = interaction.options.getString("note") || "";

      // add role
      const member = await guild.members.fetch(user.id);
      if (vipRole && !member.roles.cache.has(vipRole.id)) {
        await member.roles.add(vipRole.id, "VIP add/extend");
      }

      const res = await addOrExtendVip(user.id, days, note);

      scheduleVipListUpdate("vip_add");

      if (res.mode === "permanent") {
        return interaction.reply({
          content: `✅ <@${user.id}> est **VIP permanent** (aucune expiration).`,
          ephemeral: true,
        });
      }

      return interaction.reply({
        content: `✅ VIP prolongé pour <@${user.id}> : **+${days} jours** → expire <t:${Math.floor(new Date(res.expiresAt).getTime() / 1000)}:F>.`,
        ephemeral: true,
      });
    }

    if (interaction.commandName === "vip_perm") {
      const user = interaction.options.getUser("joueur", true);
      const note = interaction.options.getString("note") || "VIP permanent";

      const member = await guild.members.fetch(user.id);
      if (vipRole && !member.roles.cache.has(vipRole.id)) {
        await member.roles.add(vipRole.id, "VIP permanent");
      }

      await setPermanentVip(user.id, note);
      scheduleVipListUpdate("vip_perm");

      return interaction.reply({
        content: `✅ <@${user.id}> est maintenant **VIP permanent**.`,
        ephemeral: true,
      });
    }

    if (interaction.commandName === "vip_remove") {
      const user = interaction.options.getUser("joueur", true);

      // remove role
      const member = await guild.members.fetch(user.id).catch(() => null);
      if (member && vipRole && member.roles.cache.has(vipRole.id)) {
        await member.roles.remove(vipRole.id, "VIP removed");
      }

      await removeVipRecord(user.id);
      scheduleVipListUpdate("vip_remove");

      return interaction.reply({
        content: `✅ VIP retiré pour <@${user.id}> (rôle + enregistrement supprimés).`,
        ephemeral: true,
      });
    }

    if (interaction.commandName === "vip_info") {
      const user = interaction.options.getUser("joueur", true);
      const db = loadVipDb();
      const info = db[user.id];

      if (!info) {
        return interaction.reply({ content: `ℹ️ <@${user.id}> n'a pas d'enregistrement VIP.`, ephemeral: true });
      }

      if (info.permanent) {
        return interaction.reply({
          content: `👑 <@${user.id}> est **VIP permanent**.\n📝 Note: ${info.note || "—"}\n🕒 Maj: ${info.updatedAt}`,
          ephemeral: true,
        });
      }

      const exp = info.expiresAt ? Math.floor(new Date(info.expiresAt).getTime() / 1000) : null;
      return interaction.reply({
        content: `👑 <@${user.id}> VIP temporaire.\n⏰ Expire: ${exp ? `<t:${exp}:F>` : "—"}\n📝 Note: ${info.note || "—"}\n🕒 Maj: ${info.updatedAt}`,
        ephemeral: true,
      });
    }

    if (interaction.commandName === "vip_refresh") {
      scheduleVipListUpdate("vip_refresh");
      return interaction.reply({ content: "✅ Mise à jour de la liste VIP lancée.", ephemeral: true });
    }
  } catch (e) {
    console.error("❌ interaction error:", e?.message || e);
    return interaction.reply({ content: `❌ Erreur: ${e?.message || e}`, ephemeral: true }).catch(() => {});
  }
});

// ===================== EVENTS FOR INSTANT LIST UPDATE =====================
client.on("guildMemberUpdate", async (oldMember, newMember) => {
  const vip = ENV.VIP_ROLE_ID;

  // partial safe
  if (oldMember.partial) { try { oldMember = await oldMember.fetch(); } catch {} }
  if (newMember.partial) { try { newMember = await newMember.fetch(); } catch {} }

  const before = oldMember.roles.cache.has(vip);
  const after = newMember.roles.cache.has(vip);

  if (before !== after) {
    scheduleVipListUpdate(after ? "VIP added" : "VIP removed");
  }
});

// ===================== READY =====================
client.once("clientReady", async () => {
  console.log(`🤖 Connecté : ${client.user.tag}`);

  await registerGuildCommands();

  // first update list
  scheduleVipListUpdate("startup");

  // check expirations every hour
  setInterval(() => {
    checkVipExpirations().catch((e) => console.error("❌ checkVipExpirations:", e?.message || e));
  }, 60 * 60 * 1000);

  // safety list refresh every 15 min (pas trop fréquent)
  setInterval(() => scheduleVipListUpdate("periodic safety"), 15 * 60 * 1000);
});

client.login(ENV.DISCORD_TOKEN);
