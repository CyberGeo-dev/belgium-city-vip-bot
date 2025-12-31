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

/* ===================== ENV ===================== */
const ENV = {
  DISCORD_TOKEN: process.env.DISCORD_TOKEN,
  CLIENT_ID: process.env.CLIENT_ID,
  GUILD_ID: process.env.GUILD_ID,
  VIP_ROLE_ID: process.env.VIP_ROLE_ID,
  VIP_CHANNEL_ID: process.env.VIP_CHANNEL_ID,
  STAFF_ALERT_CHANNEL_ID: process.env.STAFF_ALERT_CHANNEL_ID,
  VIP_MESSAGE_ID: process.env.VIP_MESSAGE_ID || "",
  MONGODB_URI: process.env.MONGODB_URI,
};

for (const [k, v] of Object.entries(ENV)) {
  if (!v && k !== "VIP_MESSAGE_ID") throw new Error(`Missing env: ${k}`);
}

/* ===================== CONSTANTS ===================== */
const EPHEMERAL = 1 << 6;
const DAY_MS = 24 * 60 * 60 * 1000;
const GRACE_DAYS = 3;

/* ===================== CLIENT ===================== */
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.GuildMember],
});

/* ===================== MONGODB ===================== */
let vipCol;

async function initMongo() {
  const mongo = new MongoClient(ENV.MONGODB_URI);
  await mongo.connect();
  vipCol = mongo.db("vipbot").collection("vips");
  await vipCol.createIndex({ userId: 1 }, { unique: true });
  console.log("✅ MongoDB connected");
}

/* ===================== HELPERS ===================== */
const unix = (d) => Math.floor(d.getTime() / 1000);
const addDays = (d, n) => new Date(d.getTime() + n * DAY_MS);

async function guild() {
  return client.guilds.fetch(ENV.GUILD_ID);
}

async function vipChannel() {
  const c = await client.channels.fetch(ENV.VIP_CHANNEL_ID);
  if (!c?.isTextBased()) throw new Error("VIP channel invalid");
  return c;
}

async function staffChannel() {
  const c = await client.channels.fetch(ENV.STAFF_ALERT_CHANNEL_ID);
  if (!c?.isTextBased()) throw new Error("Staff channel invalid");
  return c;
}

/* ===================== VIP LIST MESSAGE ===================== */
let updateTimer;
async function updateVipList(reason = "unknown") {
  clearTimeout(updateTimer);
  updateTimer = setTimeout(async () => {
    const g = await guild();
    await g.members.fetch();

    const role = await g.roles.fetch(ENV.VIP_ROLE_ID);
    const members = [...role.members.values()].sort((a, b) =>
      a.displayName.localeCompare(b.displayName, "fr")
    );

    const lines = members.slice(0, 60).map(m => `• ${m.user} — ${m.displayName}`);
    const embed = new EmbedBuilder()
      .setTitle("👑 Liste des VIP")
      .setDescription(`**Total : ${members.length} VIP**\n\n${lines.join("\n")}`)
      .setTimestamp();

    const ch = await vipChannel();

    if (ENV.VIP_MESSAGE_ID) {
      try {
        const msg = await ch.messages.fetch(ENV.VIP_MESSAGE_ID);
        return msg.edit({ embeds: [embed] });
      } catch {
        ENV.VIP_MESSAGE_ID = "";
      }
    }

    const msg = await ch.send({ embeds: [embed] });
    ENV.VIP_MESSAGE_ID = msg.id;
    console.log("➡️ VIP_MESSAGE_ID =", msg.id);
  }, 600);
}

/* ===================== EXPIRATIONS ===================== */
async function checkExpirations() {
  const g = await guild();
  const roleId = ENV.VIP_ROLE_ID;
  const now = Date.now();

  const cursor = vipCol.find({ permanent: false, expiresAt: { $ne: null } });
  for await (const vip of cursor) {
    const exp = new Date(vip.expiresAt);
    const graceEnd = addDays(exp, GRACE_DAYS);
    const daysLeft = Math.ceil((exp - now) / DAY_MS);
    const alerts = vip.alerts || {};

    if (daysLeft === 3 && !alerts.d3) {
      alerts.d3 = true;
      await staffChannel().then(c =>
        c.send(`⏰ **J-3** : <@${vip.userId}> expire le <t:${unix(exp)}:F>`)
      );
    }

    if (daysLeft === 1 && !alerts.d1) {
      alerts.d1 = true;
      await staffChannel().then(c =>
        c.send(`⏰ **J-1** : <@${vip.userId}> expire demain`)
      );
    }

    if (now >= exp && now < graceEnd && !alerts.d0) {
      alerts.d0 = true;
      await staffChannel().then(c =>
        c.send(`⚠️ **Échéance atteinte** : <@${vip.userId}> (grâce ${GRACE_DAYS}j)`)
      );
    }

    if (now >= graceEnd && !alerts.removed) {
      alerts.removed = true;
      try {
        const m = await g.members.fetch(vip.userId);
        await m.roles.remove(roleId);
      } catch {}
      await staffChannel().then(c =>
        c.send(`❌ **VIP retiré** : <@${vip.userId}> (fin de grâce)`)
      );
      updateVipList("expired");
    }

    await vipCol.updateOne({ userId: vip.userId }, { $set: { alerts } });
  }
}

/* ===================== SLASH COMMANDS ===================== */
const commands = [
  new SlashCommandBuilder()
    .setName("vip_add")
    .setDescription("Ajoute ou prolonge un VIP")
    .addUserOption(o => o.setName("joueur").setRequired(true))
    .addIntegerOption(o => o.setName("jours").setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName("vip_perm")
    .setDescription("Met un VIP permanent")
    .addUserOption(o => o.setName("joueur").setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName("vip_remove")
    .setDescription("Retire le VIP")
    .addUserOption(o => o.setName("joueur").setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName("vip_info")
    .setDescription("Infos VIP d’un joueur")
    .addUserOption(o => o.setName("joueur").setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName("vip_list")
    .setDescription("Liste tous les VIP")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName("vip_refresh")
    .setDescription("Force la mise à jour de la liste")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
].map(c => c.toJSON());

/* ===================== INTERACTIONS ===================== */
client.on("interactionCreate", async (i) => {
  if (!i.isChatInputCommand()) return;

  const g = await guild();
  const role = await g.roles.fetch(ENV.VIP_ROLE_ID);

  if (i.commandName === "vip_add") {
    const u = i.options.getUser("joueur");
    const days = i.options.getInteger("jours");
    const m = await g.members.fetch(u.id);

    await m.roles.add(role);
    const exp = addDays(new Date(), days);

    await vipCol.updateOne(
      { userId: u.id },
      { $set: { userId: u.id, permanent: false, expiresAt: exp, alerts: {} } },
      { upsert: true }
    );

    updateVipList("vip_add");
    return i.reply({ content: `✅ VIP jusqu’au <t:${unix(exp)}:F>`, flags: EPHEMERAL });
  }

  if (i.commandName === "vip_perm") {
    const u = i.options.getUser("joueur");
    const m = await g.members.fetch(u.id);
    await m.roles.add(role);

    await vipCol.updateOne(
      { userId: u.id },
      { $set: { userId: u.id, permanent: true, expiresAt: null, alerts: {} } },
      { upsert: true }
    );

    updateVipList("vip_perm");
    return i.reply({ content: `👑 VIP permanent`, flags: EPHEMERAL });
  }

  if (i.commandName === "vip_remove") {
    const u = i.options.getUser("joueur");
    await vipCol.deleteOne({ userId: u.id });
    try {
      const m = await g.members.fetch(u.id);
      await m.roles.remove(role);
    } catch {}
    updateVipList("vip_remove");
    return i.reply({ content: "❌ VIP retiré", flags: EPHEMERAL });
  }

  if (i.commandName === "vip_list") {
    const all = await vipCol.find({}).toArray();
    if (!all.length) return i.reply({ content: "Aucun VIP", flags: EPHEMERAL });

    const lines = all.map(v =>
      v.permanent
        ? `🟣 <@${v.userId}> — Permanent`
        : `🟢 <@${v.userId}> — expire <t:${unix(new Date(v.expiresAt))}:F>`
    );

    return i.reply({ content: lines.join("\n"), flags: EPHEMERAL });
  }

  if (i.commandName === "vip_refresh") {
    updateVipList("manual");
    return i.reply({ content: "🔄 Mise à jour lancée", flags: EPHEMERAL });
  }
});

/* ===================== READY ===================== */
client.once("clientReady", async () => {
  console.log(`🤖 Connecté : ${client.user.tag}`);

  await initMongo();

  const rest = new REST({ version: "10" }).setToken(ENV.DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(ENV.CLIENT_ID, ENV.GUILD_ID), { body: commands });
  console.log("✅ Slash commands enregistrées");

  updateVipList("startup");
  setInterval(checkExpirations, 5 * 60 * 1000);
});

client.login(ENV.DISCORD_TOKEN);
