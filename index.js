import "dotenv/config";
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
import { MongoClient } from "mongodb";

// ===================== ENV =====================
const ENV = {
  DISCORD_TOKEN: (process.env.DISCORD_TOKEN || "").trim(),
  CLIENT_ID: (process.env.CLIENT_ID || "").trim(),
  GUILD_ID: (process.env.GUILD_ID || "").trim(),
  VIP_ROLE_ID: (process.env.VIP_ROLE_ID || "").trim(),
  VIP_CHANNEL_ID: (process.env.VIP_CHANNEL_ID || "").trim(),
  VIP_MESSAGE_ID: (process.env.VIP_MESSAGE_ID || "").trim(), // peut être vide au 1er run
  STAFF_ALERT_CHANNEL_ID: (process.env.STAFF_ALERT_CHANNEL_ID || "").trim(),
  MONGODB_URI: (process.env.MONGODB_URI || "").trim(),
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
must("MONGODB_URI");

// ===================== CONSTANTS =====================
const EPHEMERAL_FLAGS = 1 << 6; // MessageFlags.Ephemeral
const GRACE_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

// Rappels
const REMIND_D3 = 3;
const REMIND_D1 = 1;

// Fréquences
const EXPIRY_CHECK_EVERY_MS = 5 * 60 * 1000;      // 5 min
const VIP_LIST_SAFETY_EVERY_MS = 15 * 60 * 1000;  // 15 min

// ===================== MONGODB =====================
let mongo;
let vipCol;

async function initMongo() {
  mongo = new MongoClient(ENV.MONGODB_URI);
  await mongo.connect();
  const db = mongo.db("vipbot");
  vipCol = db.collection("vips");

  await vipCol.createIndex({ userId: 1 }, { unique: true });
  await vipCol.createIndex({ expiresAt: 1 });

  console.log("✅ MongoDB connected");
}

// Document Mongo:
// {
//   userId: "123",
//   permanent: true/false,
//   expiresAt: Date | null,
//   note: "texte",
//   alerts: { d3:true, d1:true, d0:true, removed:true },
//   createdAt: Date,
//   updatedAt: Date
// }

// ===================== CLIENT =====================
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.GuildMember],
});

client.on("error", (e) => console.error("Client error:", e));
process.on("unhandledRejection", (e) => console.error("UnhandledRejection:", e));
process.on("uncaughtException", (e) => console.error("UncaughtException:", e));

// ===================== HELPERS =====================
function addDays(baseDate, days) {
  const d = new Date(baseDate);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}
function toUnixTs(date) {
  return Math.floor(date.getTime() / 1000);
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
async function sendStaffAlert(text) {
  const ch = await getStaffAlertChannel();
  await ch.send({ content: text });
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

// ===================== VIP DB (Mongo) =====================
async function getVip(userId) {
  return await vipCol.findOne({ userId });
}

// ✅ IMPORTANT: pas de alerts dans $setOnInsert (sinon conflit)
async function upsertVip(userId, patch) {
  const set = {
    ...patch,
    userId,
    updatedAt: new Date(),
  };

  await vipCol.updateOne(
    { userId },
    {
      $set: set,
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true }
  );
}

async function deleteVip(userId) {
  await vipCol.deleteOne({ userId });
}

async function addOrExtendVip(userId, days, note = "") {
  const existing = await getVip(userId);

  // permanent -> ne touche pas expiresAt
  if (existing?.permanent) {
    await upsertVip(userId, { note: note || existing.note || "" });
    return { mode: "permanent", expiresAt: null };
  }

  const now = Date.now();
  const baseMs = existing?.expiresAt ? new Date(existing.expiresAt).getTime() : 0;
  const start = baseMs > now ? new Date(baseMs) : new Date();
  const newExp = addDays(start, days);

  await upsertVip(userId, {
    permanent: false,
    expiresAt: newExp,
    note: note || existing?.note || "",
    alerts: {}, // reset flags au renouvellement
  });

  return { mode: "temporary", expiresAt: newExp.toISOString() };
}

async function setPermanentVip(userId, note = "") {
  await upsertVip(userId, {
    permanent: true,
    expiresAt: null,
    note: note || "VIP permanent",
    alerts: {}, // reset flags
  });
}

// ===================== EXPIRATIONS + GRACE =====================
async function checkVipExpirations() {
  const guild = await getGuild();
  const roleId = ENV.VIP_ROLE_ID;
  const now = Date.now();

  const cursor = vipCol.find({ permanent: { $ne: true }, expiresAt: { $ne: null } });

  for await (const info of cursor) {
    const userId = info.userId;
    const alerts = info.alerts || {};

    const expMs = new Date(info.expiresAt).getTime();
    const graceEndMs = expMs + GRACE_DAYS * DAY_MS;
    const daysToExpire = Math.ceil((expMs - now) / DAY_MS);

    // J-3
    if (daysToExpire <= REMIND_D3 && daysToExpire > REMIND_D1 && !alerts.d3) {
      alerts.d3 = true;
      await vipCol.updateOne({ userId }, { $set: { alerts } });
      await sendStaffAlert(
        `⏰ **Alerte VIP (J-3)** : <@${userId}> expire dans **3 jours** (échéance: <t:${Math.floor(expMs / 1000)}:F>).`
      );
    }

    // J-1
    if (daysToExpire <= REMIND_D1 && daysToExpire > 0 && !alerts.d1) {
      alerts.d1 = true;
      await vipCol.updateOne({ userId }, { $set: { alerts } });
      await sendStaffAlert(
        `⏰ **Alerte VIP (J-1)** : <@${userId}> expire **demain** (échéance: <t:${Math.floor(expMs / 1000)}:F>).`
      );
    }

    // J0
    if (now >= expMs && now < graceEndMs && !alerts.d0) {
      alerts.d0 = true;
      await vipCol.updateOne({ userId }, { $set: { alerts } });
      await sendStaffAlert(
        `⚠️ **VIP arrivé à échéance** : <@${userId}> (échéance: <t:${Math.floor(expMs / 1000)}:F>). **Délai de grâce : ${GRACE_DAYS} jours**.`
      );
    }

    // fin de grâce => retrait rôle
    if (now >= graceEndMs && !alerts.removed) {
      alerts.removed = true;
      await vipCol.updateOne({ userId }, { $set: { alerts } });

      try {
        const member = await guild.members.fetch(userId);
        if (member.roles.cache.has(roleId)) {
          await member.roles.remove(roleId, "VIP expired after grace period");
        }
      } catch {}

      await sendStaffAlert(
        `❌ **Fin de grâce (J+${GRACE_DAYS})** : <@${userId}> non renouvelé → **VIP retiré automatiquement** (échéance: <t:${Math.floor(
          expMs / 1000
        )}:F>, fin de grâce: <t:${Math.floor(graceEndMs / 1000)}:F>).`
      );

      scheduleVipListUpdate("expired removed");
    }
  }
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

  // ✅ RE-ADD vip_list (comme avant)
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
    return interaction.reply({ content: "❌ Tu n'as pas la permission.", flags: EPHEMERAL_FLAGS });
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
      checkVipExpirations().catch(() => {});

      if (res.mode === "permanent") {
        return interaction.reply({
          content: `✅ <@${user.id}> est **VIP permanent**.`,
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

      await deleteVip(user.id);
      scheduleVipListUpdate("vip_remove");

      return interaction.reply({
        content: `✅ VIP retiré pour <@${user.id}> (rôle + enregistrement supprimés).`,
        flags: EPHEMERAL_FLAGS,
      });
    }

    if (interaction.commandName === "vip_info") {
      const user = interaction.options.getUser("joueur", true);
      const info = await getVip(user.id);

      if (!info) {
        return interaction.reply({
          content: `ℹ️ <@${user.id}> n'a pas d'enregistrement VIP.`,
          flags: EPHEMERAL_FLAGS,
        });
      }

      if (info.permanent) {
        return interaction.reply({
          content:
            `👑 <@${user.id}> est **VIP permanent**.\n` +
            `📝 Note: ${info.note || "—"}\n` +
            `🕒 Maj: ${info.updatedAt ? info.updatedAt.toISOString() : "—"}`,
          flags: EPHEMERAL_FLAGS,
        });
      }

      const exp = info.expiresAt ? new Date(info.expiresAt) : null;
      const expTs = exp ? toUnixTs(exp) : null;
      const graceEndTs = exp ? Math.floor((exp.getTime() + GRACE_DAYS * DAY_MS) / 1000) : null;

      return interaction.reply({
        content:
          `👑 <@${user.id}> VIP temporaire.\n` +
          `⏰ Échéance: ${expTs ? `<t:${expTs}:F>` : "—"}\n` +
          `🕒 Fin de grâce (${GRACE_DAYS}j): ${graceEndTs ? `<t:${graceEndTs}:F>` : "—"}\n` +
          `📝 Note: ${info.note || "—"}`,
        flags: EPHEMERAL_FLAGS,
      });
    }

    if (interaction.commandName === "vip_list") {
      const page = interaction.options.getInteger("page") || 1;
      const expiringOnly = interaction.options.getBoolean("expiring_only") || false;

      const now = Date.now();
      const all = await vipCol.find({}).toArray();

      let rows = all.map((info) => {
        const permanent = !!info.permanent;

        let expTs = null;
        let remainingDays = null;

        if (!permanent && info.expiresAt) {
          const expMs = new Date(info.expiresAt).getTime();
          expTs = Math.floor(expMs / 1000);
          remainingDays = Math.ceil((expMs - now) / DAY_MS);
        }

        return { userId: info.userId, permanent, expTs, remainingDays, note: info.note || "—" };
      });

      if (expiringOnly) {
        rows = rows.filter((r) => !r.permanent && r.remainingDays !== null && r.remainingDays <= 14);
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

  await initMongo();
  await registerGuildCommands();

  scheduleVipListUpdate("startup");
  await checkVipExpirations().catch(() => {});

  setInterval(() => {
    checkVipExpirations().catch((e) =>
      console.error("❌ checkVipExpirations:", e?.message || e)
    );
  }, EXPIRY_CHECK_EVERY_MS);

  setInterval(() => scheduleVipListUpdate("periodic safety"), VIP_LIST_SAFETY_EVERY_MS);
});

client.login(ENV.DISCORD_TOKEN);
