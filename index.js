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
  VIP_MESSAGE_ID: (process.env.VIP_MESSAGE_ID || "").trim(), // peut être vide au 1er run
  STAFF_ALERT_CHANNEL_ID: (process.env.STAFF_ALERT_CHANNEL_ID || "").trim(), // tu peux mettre pareil que VIP_CHANNEL_ID
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

// ===================== CONSTANTS =====================
const EPHEMERAL_FLAGS = 1 << 6; // MessageFlags.Ephemeral
const GRACE_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

// ===================== JSON DB =====================
// ⚠️ Railway: FS peut être éphémère selon config. Pour du 100% durable -> SQLite + volume/DB.
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
//   alerts: { d3?: true, d1?: true, d0?: true, g3?: true, removed?: true },
//   updatedAt: string
// }

// ===================== CLIENT =====================
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.GuildMember],
});

// avoid crash
client.on("error", (e) => console.error("Client error:", e));
process.on("unhandledRejection", (e) => console.error("UnhandledRejection:", e));
process.on("uncaughtException", (e) => console.error("UncaughtException:", e));

// ===================== HELPERS =====================
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
  }, 600);
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
  await guild.members.fetch(); // pour role.members fiable

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

// ===================== ALERTS & GRACE =====================
async function sendStaffAlert(text) {
  const ch = await getStaffAlertChannel();
  await ch.send({ content: text });
}

// Rappels + grâce 3 jours + retrait auto à J+3
async function checkVipExpirations() {
  const db = loadVipDb();
  const guild = await getGuild();
  const roleId = ENV.VIP_ROLE_ID;
  const now = Date.now();

  let changed = false;

  for (const [userId, info] of Object.entries(db)) {
    info.alerts = info.alerts || {};

    // permanents : rien à faire
    if (info.permanent) continue;
    if (!info.expiresAt) continue;

    const expMs = new Date(info.expiresAt).getTime();
    const graceEndMs = expMs + GRACE_DAYS * DAY_MS;

    const daysToExpire = Math.ceil((expMs - now) / DAY_MS);      // ex: 3, 1, 0, -1...
    const daysPastExpire = Math.floor((now - expMs) / DAY_MS);   // ex: 0,1,2,3...

    // ---- Rappels AVANT échéance ----
    if (daysToExpire <= 3 && daysToExpire > 1 && !info.alerts.d3) {
      info.alerts.d3 = true;
      changed = true;
      await sendStaffAlert(
        `⏰ **Alerte VIP (J-3)** : <@${userId}> expire dans **3 jours** (échéance: <t:${Math.floor(expMs / 1000)}:F>).`
      );
    }

    if (daysToExpire <= 1 && daysToExpire > 0 && !info.alerts.d1) {
      info.alerts.d1 = true;
      changed = true;
      await sendStaffAlert(
        `⏰ **Alerte VIP (J-1)** : <@${userId}> expire **demain** (échéance: <t:${Math.floor(expMs / 1000)}:F>).`
      );
    }

    // ---- Échéance atteinte (début de grâce) ----
    if (now >= expMs && now < graceEndMs && !info.alerts.d0) {
      info.alerts.d0 = true;
      changed = true;
      await sendStaffAlert(
        `⚠️ **VIP arrivé à échéance** : <@${userId}> a atteint la date d’échéance (échéance: <t:${Math.floor(
          expMs / 1000
        )}:F>). **Délai de grâce : ${GRACE_DAYS} jours**.`
      );
    }

    // ---- Fin de grâce (J+3) : on retire le rôle ----
    if (now >= graceEndMs && !info.alerts.removed) {
      info.alerts.g3 = true;
      info.alerts.removed = true;
      changed = true;

      // Retrait du rôle VIP
      try {
        const member = await guild.members.fetch(userId);
        if (member.roles.cache.has(roleId)) {
          await member.roles.remove(roleId, "VIP expired after grace period");
        }
      } catch {
        // membre absent ou impossible à fetch
      }

      await sendStaffAlert(
        `❌ **Fin de grâce (J+${GRACE_DAYS})** : <@${userId}> n’a pas été renouvelé. **Rôle VIP retiré automatiquement** (échéance initiale: <t:${Math.floor(
          expMs / 1000
        )}:F>, fin de grâce: <t:${Math.floor(graceEndMs / 1000)}:F>).`
      );
    }
  }

  if (changed) saveVipDb(db);

  // garder la liste synchronisée
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
    // VIP permanent : on ne touche pas à expiresAt
    info.updatedAt = nowIso();
    if (note) info.note = note;
    db[userId] = info;
    saveVipDb(db);
    return { mode: "permanent", expiresAt: null };
  }

  const now = Date.now();
  const baseMs = info.expiresAt ? new Date(info.expiresAt).getTime() : 0;

  // Si déjà actif -> prolonge depuis expiresAt, sinon depuis maintenant
  const start = baseMs > now ? new Date(baseMs) : new Date();
  const newExp = addDays(start, days);

  info.permanent = false;
  info.expiresAt = newExp.toISOString();
  info.note = note || info.note || "";
  info.alerts = {}; // reset alerts dès qu'on renouvelle
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
        content: `✅ VIP prolongé pour <@${user.id}> : **+${days} jours** → expire <t:${exp}:F>. (grâce ${GRACE_DAYS} jours)`,
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

      const expMs = info.expiresAt ? new Date(info.expiresAt).getTime() : null;
      const expTs = expMs ? Math.floor(expMs / 1000) : null;
      const graceEndTs = expMs ? Math.floor((expMs + GRACE_DAYS * DAY_MS) / 1000) : null;

      return interaction.reply({
        content:
          `👑 <@${user.id}> VIP temporaire.\n` +
          `⏰ Échéance: ${expTs ? `<t:${expTs}:F>` : "—"}\n` +
          `🕒 Fin de grâce (${GRACE_DAYS}j): ${graceEndTs ? `<t:${graceEndTs}:F>` : "—"}\n` +
          `📝 Note: ${info.note || "—"}\n` +
          `🕒 Maj: ${info.updatedAt}`,
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
          remainingDays = Math.ceil((expMs - now) / DAY_MS);
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

        // code couleur simple
        // d <= 0 -> déjà à échéance (grâce possible)
        const badge = d <= 0 ? "🔴" : d <= 3 ? "🟠" : d <= 7 ? "🟡" : "🟢";

        return `${badge} <@${r.userId}> — échéance ${when} (**J-${d}**) — ${r.note}`;
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

  if (before !== after) scheduleVipListUpdate(after ? "VIP added" : "VIP removed");
});

client.on("guildMemberRemove", () => {
  scheduleVipListUpdate("member left");
});

// ===================== READY =====================
client.once("clientReady", async () => {
  console.log(`🤖 Connecté : ${client.user.tag}`);

  await registerGuildCommands();

  // first list update
  scheduleVipListUpdate("startup");

  // scan échéances (toutes les 30 minutes = plus réactif)
  setInterval(() => {
    checkVipExpirations().catch((e) => console.error("❌ checkVipExpirations:", e?.message || e));
  }, 30 * 60 * 1000);

  // safety refresh list
  setInterval(() => scheduleVipListUpdate("periodic safety"), 15 * 60 * 1000);
});

client.login(ENV.DISCORD_TOKEN);
