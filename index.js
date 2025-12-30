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
  STAFF_ALERT_CHANNEL_ID: (process.env.STAFF_ALERT_CHANNEL_ID || "").trim(), // peut être égal à VIP_CHANNEL_ID
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

// ===================== JSON DB =====================
// ⚠️ Sur Railway, le FS peut être éphémère selon configuration. Pour du 100% sûr -> SQLite + volume/DB.
const DATA_DIR = path.join(process.cwd(), "data");
const VIP_DB_FILE = path.join(DATA_DIR, "vip.json");

function ensureDataStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(VIP_DB_FILE)) fs.writeFileSync(VIP_DB_FILE, JSON.stringify({}, null, 2));
}

function loadVipDb() {
  ensureDataStore();
  try {
    return JSON.parse(fs.readFileSync(VIP_DB_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveVipDb(db) {
  ensureDataStore();
  fs.writeFileSync(VIP_DB_FILE, JSON.stringify(db, null, 2));
}

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

// Avoid crash on Railway
client.on("error", (e) => console.error("Client error:", e));
process.on("unhandledRejection", (e) => console.error("UnhandledRejection:", e));
process.on("uncaughtException", (e) => console.error("UncaughtException:", e));

// ===================== HELPERS =====================
const EPHEMERAL_FLAGS = 1 << 6; // MessageFlags.Ephemeral

function nowIso() {
  return new Date().toISOString();
}

function addDays(baseDate, days) {
  const d = new Date(baseDate);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

async function getGuild() {
  return await client.guilds.fetch(ENV.GUILD_ID);
}

async function getVipChannel() {
  const ch = await client.channels.fetch(ENV.VIP_CHANNEL_ID);
  if (!ch?.isTextBased()) throw new Error("VIP_CHANNEL_ID n'est pas un salon texte.");
  return ch;
}

async function getStaffAlertChannel() {
  const ch = await client.channels.fetch(ENV.STAFF_ALERT_CHANNEL_ID);
  if (!ch?.isTextBased()) throw new Error("STAFF_ALERT_CHANNEL_ID n'est pas un salon texte.");
  return ch;
}

function isAdminInteraction(interaction) {
  return (
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ||
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
  );
}

// ===================== VIP LIST (ONE MESSAGE) =====================
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
  }, 600); // quasi instant
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
  const guild = await getGuild();
  // garde members cache à jour pour role.members
  await guild.members.fetch();

  const channel = await getVipChannel();
  const embed = await buildVipListEmbed(guild);

  const msgId = (ENV.VIP_MESSAGE_ID || "").trim();

  if (msgId) {
    try {
      const msg = await channel.messages.fetch(msgId);
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
async function sendStaffAlert(text) {
  const ch = await getStaffAlertChannel();
  await ch.send({ content: text });
}

async function checkVipExpirations() {
  const db = loadVipDb();
  const guild = await getGuild();
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

    const expMs = new Date(info.expiresAt).getTime();
    const remaining = expMs - now;

    // before expiry alerts
    for (const t of thresholds) {
      if (!info.alerts[t.key] && remaining <= t.ms && remaining > 0) {
        info.alerts[t.key] = true;
        changed = true;

        await sendStaffAlert(
          `⏰ **Alerte VIP**: <@${userId}> expire **${t.label}** (expiration: <t:${Math.floor(
            expMs / 1000
          )}:F>).`
        );
      }
    }

    // expired
    if (remaining <= 0 && !info.alerts.expired) {
      info.alerts.expired = true;
      changed = true;

      try {
        const member = await guild.members.fetch(userId);
        if (member.roles.cache.has(roleId)) {
          await member.roles.remove(roleId, "VIP expired");
        }

        await sendStaffAlert(
          `❌ **VIP expiré**: <@${userId}> vient d’expirer (expiration: <t:${Math.floor(
            expMs / 1000
          )}:F>). Rôle retiré automatiquement.`
        );
      } catch {
        await sendStaffAlert(
          `❌ **VIP expiré**: <@${userId}> a expiré (expiration: <t:${Math.floor(
            expMs / 1000
          )}:F>). (Membre introuvable ou rôle déjà retiré)`
        );
      }

      // option: garder l'historique. (on ne delete pas)
    }
  }

  if (changed) saveVipDb(db);

  // keep list synced
  scheduleVipListUpdate("expiry check");
}

// ===================== VIP DB MUTATIONS =====================
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
    info.updatedAt = nowIso();
    if (note) info.note = note;
    db[userId] = info;
    saveVipDb(db);
    return { mode: "permanent", expiresAt: null };
  }

  const now = Date.now();
  const baseMs = info.expiresAt ? new Date(info.expiresAt).getTime() : 0;
  const start = baseMs > now ? new Date(baseMs) : new Date();

  const newExp = addDays(start, days);

  info.permanent = false;
  info.expiresAt = newExp.toISOString();
  info.note = note || info.note || "";
  info.alerts = {}; // reset alerts when extended/created
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
    .addUserOption((o) => o.setName("joueur").setDescription("Le joueur").setRequired(true))
    .addIntegerOption((o) =>
      o.setName("jours").setDescription("Nombre de jours (ex: 30, 60, 90)").setRequired(true)
    )
    .addStringOption((o) => o.setName("note").setDescription("Note interne").setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName("vip_perm")
    .setDescription("Met un VIP permanent.")
    .addUserOption((o) => o.setName("joueur").setDescription("Le joueur").setRequired(true))
    .addStringOption((o) => o.setName("note").setDescription("Note interne").setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName("vip_remove")
    .setDescription("Retire le rôle VIP et supprime l'enregistrement.")
    .addUserOption((o) => o.setName("joueur").setDescription("Le joueur").setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName("vip_info")
    .setDescription("Affiche les infos VIP d'un joueur.")
    .addUserOption((o) => o.setName("joueur").setDescription("Le joueur").setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName("vip_list")
    .setDescription("Liste tous les VIP enregistrés (temporaire + permanent).")
    .addIntegerOption((o) =>
      o.setName("page").setDescription("Numéro de page (25 VIP par page)").setRequired(false)
    )
    .addBooleanOption((o) =>
      o
        .setName("expiring_only")
        .setDescription("Seulement ceux qui expirent bientôt (<= 14 jours)")
        .setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName("vip_refresh")
    .setDescription("Force la mise à jour de la liste VIP.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
].map((c) => c.toJSON());

async function registerGuildCommands() {
  const rest = new REST({ version: "10" }).setToken(ENV.DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(ENV.CLIENT_ID, ENV.GUILD_ID), { body: commands });
  console.log("✅ Slash commands registered (guild).");
}

// ===================== INTERACTIONS =====================
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (!isAdminInteraction(interaction)) {
    return interaction.reply({
      content: "❌ Tu n'as pas la permission.",
      flags: EPHEMERAL_FLAGS,
    });
  }

  const guild = await getGuild();
  const vipRole = await guild.roles.fetch(ENV.VIP_ROLE_ID).catch(() => null);

  try {
    if (interaction.commandName === "vip_add") {
      const user = interaction.options.getUser("joueur", true);
      const days = interaction.options.getInteger("jours", true);
      const note = interaction.options.getString("note") || "";

      const member = await guild.members.fetch(user.id);

      if (vipRole && !member.roles.cache.has(vipRole.id)) {
        await member.roles.add(vipRole.id, "VIP add/extend");
      }

      const res = await addOrExtendVip(user.id, days, note);
      scheduleVipListUpdate("vip_add");

      if (res.mode === "permanent") {
        return interaction.reply({
          content: `✅ <@${user.id}> est **VIP permanent** (aucune expiration).`,
          flags: EPHEMERAL_FLAGS,
        });
      }

      const exp = Math.floor(new Date(res.expiresAt).getTime() / 1000);
      return interaction.reply({
        content: `✅ VIP prolongé pour <@${user.id}> : **+${days} jours** → expire <t:${exp}:F>.`,
        flags: EPHEMERAL_FLAGS,
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
        flags: EPHEMERAL_FLAGS,
      });
    }

    if (interaction.commandName === "vip_remove") {
      const user = interaction.options.getUser("joueur", true);

      const member = await guild.members.fetch(user.id).catch(() => null);
      if (member && vipRole && member.roles.cache.has(vipRole.id)) {
        await member.roles.remove(vipRole.id, "VIP removed");
      }

      await removeVipRecord(user.id);
      scheduleVipListUpdate("vip_remove");

      return interaction.reply({
        content: `✅ VIP retiré pour <@${user.id}> (rôle + enregistrement supprimés).`,
        flags: EPHEMERAL_FLAGS,
      });
    }

    if (interaction.commandName === "vip_info") {
      const user = interaction.options.getUser("joueur", true);
      const db = loadVipDb();
      const info = db[user.id];

      if (!info) {
        return interaction.reply({
          content: `ℹ️ <@${user.id}> n'a pas d'enregistrement VIP.`,
          flags: EPHEMERAL_FLAGS,
        });
      }

      if (info.permanent) {
        return interaction.reply({
          content: `👑 <@${user.id}> est **VIP permanent**.\n📝 Note: ${
            info.note || "—"
          }\n🕒 Maj: ${info.updatedAt}`,
          flags: EPHEMERAL_FLAGS,
        });
      }

      const exp = info.expiresAt ? Math.floor(new Date(info.expiresAt).getTime() / 1000) : null;
      return interaction.reply({
        content: `👑 <@${user.id}> VIP temporaire.\n⏰ Expire: ${
          exp ? `<t:${exp}:F>` : "—"
        }\n📝 Note: ${info.note || "—"}\n🕒 Maj: ${info.updatedAt}`,
        flags: EPHEMERAL_FLAGS,
      });
    }

    if (interaction.commandName === "vip_list") {
      const page = interaction.options.getInteger("page") || 1;
      const expiringOnly = interaction.options.getBoolean("expiring_only") || false;

      const db = loadVipDb();
      const now = Date.now();

      let rows = Object.entries(db).map(([userId, info]) => {
        const permanent = !!info.permanent;

        let expTs = null;
        let remainingDays = null;

        if (!permanent && info.expiresAt) {
          const expMs = new Date(info.expiresAt).getTime();
          expTs = Math.floor(expMs / 1000);
          remainingDays = Math.ceil((expMs - now) / (24 * 60 * 60 * 1000));
        }

        return { userId, permanent, expTs, remainingDays, note: info.note || "—" };
      });

      if (expiringOnly) {
        rows = rows.filter(
          (r) => !r.permanent && r.remainingDays !== null && r.remainingDays <= 14
        );
      }

      rows.sort((a, b) => {
        if (a.permanent && !b.permanent) return 1;
        if (!a.permanent && b.permanent) return -1;
        if (!a.permanent && !b.permanent) return (a.expTs ?? 0) - (b.expTs ?? 0);
        return 0;
      });

      const perPage = 25;
      const total = rows.length;
      const totalPages = Math.max(1, Math.ceil(total / perPage));
      const safePage = Math.min(Math.max(1, page), totalPages);
      const slice = rows.slice((safePage - 1) * perPage, safePage * perPage);

      if (slice.length === 0) {
        return interaction.reply({
          content: expiringOnly
            ? "ℹ️ Aucun VIP n’expire dans les 14 prochains jours."
            : "ℹ️ Aucun VIP enregistré.",
          flags: EPHEMERAL_FLAGS,
        });
      }

      const lines = slice.map((r) => {
        if (r.permanent) return `🟣 <@${r.userId}> — **Permanent** — ${r.note}`;

        const d = r.remainingDays ?? "?";
        const when = r.expTs ? `<t:${r.expTs}:F>` : "—";
        const badge = d <= 0 ? "🔴" : d <= 3 ? "🟠" : d <= 7 ? "🟡" : "🟢";
        return `${badge} <@${r.userId}> — expire ${when} (**J-${d}**) — ${r.note}`;
      });

      const header = expiringOnly
        ? `📋 **VIP qui expirent bientôt (<= 14 jours)** — ${total} résultat(s)`
        : `📋 **Liste VIP (DB)** — ${total} VIP enregistré(s)`;

      return interaction.reply({
        content: `${header}\nPage **${safePage}/${totalPages}**\n\n${lines.join("\n")}`,
        flags: EPHEMERAL_FLAGS,
      });
    }

    if (interaction.commandName === "vip_refresh") {
      scheduleVipListUpdate("vip_refresh");
      return interaction.reply({
        content: "✅ Mise à jour de la liste VIP lancée.",
        flags: EPHEMERAL_FLAGS,
      });
    }
  } catch (e) {
    console.error("❌ interaction error:", e?.message || e);
    return interaction
      .reply({ content: `❌ Erreur: ${e?.message || e}`, flags: EPHEMERAL_FLAGS })
      .catch(() => {});
  }
});

// ===================== INSTANT LIST UPDATE =====================
client.on("guildMemberUpdate", async (oldMember, newMember) => {
  const vip = ENV.VIP_ROLE_ID;

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

  if (before !== after) {
    scheduleVipListUpdate(after ? "VIP added" : "VIP removed");
  }
});

client.on("guildMemberRemove", (member) => {
  // list update (au cas où)
  scheduleVipListUpdate("member left");
});

// ===================== READY =====================
client.once("clientReady", async () => {
  console.log(`🤖 Connecté : ${client.user.tag}`);

  await registerGuildCommands();

  // first list update
  scheduleVipListUpdate("startup");

  // expiration check every hour
  setInterval(() => {
    checkVipExpirations().catch((e) => console.error("❌ checkVipExpirations:", e?.message || e));
  }, 60 * 60 * 1000);

  // safety list refresh every 15 min
  setInterval(() => scheduleVipListUpdate("periodic safety"), 15 * 60 * 1000);
});

client.login(ENV.DISCORD_TOKEN);
