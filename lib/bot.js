import _ from 'lodash';
import irc from 'irc-upd';
import logger from 'winston';
import { RTMClient } from '@slack/rtm-api';
import { WebClient } from '@slack/web-api';
import { ConfigurationError } from './errors';
import emojis from '../assets/emoji.json';
import { validateChannelMapping } from './validators';

const ALLOWED_SUBTYPES = ['me_message', 'file_share'];
const REQUIRED_FIELDS = ['server', 'nickname', 'channelMapping', 'token'];

class Bot {
  constructor(options) {
    REQUIRED_FIELDS.forEach(field => {
      if (!options[field]) {
        throw new ConfigurationError(`Missing configuration field ${field}`);
      }
    });

    validateChannelMapping(options.channelMapping);

    const web = new WebClient(options.token);
    const rtm = new RTMClient(options.token);
    this.slack = { web, rtm };

    this.server = options.server;
    this.nickname = options.nickname;
    this.ircOptions = options.ircOptions;
    this.ircStatusNotices = options.ircStatusNotices || {};
    this.commandCharacters = options.commandCharacters || [];
    this.channels = _.values(options.channelMapping);
    this.muteSlackbot = options.muteSlackbot || false;
    this.muteUsers = {
      slack: [],
      irc: [],
      ...options.muteUsers,
    };

    const defaultUrl = 'https://picsum.photos/seed/$username/64/64';
    // Disable if it's set to false, override default with custom if available:
    this.avatarUrl =
      options.avatarUrl !== false && (options.avatarUrl || defaultUrl);
    this.slackUsernameFormat = options.slackUsernameFormat || '$username (IRC)';
    this.ircUsernameFormat =
      options.ircUsernameFormat == null
        ? '<$username> '
        : options.ircUsernameFormat;
    this.channelMapping = {};

    // Remove channel passwords from the mapping and lowercase IRC channel names
    _.forOwn(
      options.channelMapping,
      (ircChan, slackChan) => {
        this.channelMapping[slackChan] = ircChan.split(' ')[0].toLowerCase();
      },
      this,
    );

    this.invertedMapping = _.invert(this.channelMapping);
    this.autoSendCommands = options.autoSendCommands || [];
  }

  connect() {
    logger.debug('Connecting to IRC and Slack');
    this.slack.rtm.start();

    const ircOptions = {
      userName: this.nickname,
      realName: this.nickname,
      channels: this.channels,
      floodProtection: true,
      floodProtectionDelay: 500,
      retryCount: 10,
      ...this.ircOptions,
    };

    this.ircClient = new irc.Client(this.server, this.nickname, ircOptions);
    this.attachListeners();
  }

  attachListeners() {
    this.slack.rtm.on('open', async () => {
      logger.debug('Connected to Slack');
    });

    this.ircClient.on('registered', message => {
      logger.debug('Registered event: ', message);
      this.autoSendCommands.forEach(element => {
        this.ircClient.send(...element);
      });
    });

    this.ircClient.on('error', error => {
      logger.error('Received error event from IRC', error);
    });

    this.ircClient.on('abort', () => {
      logger.error('Maximum IRC retry count reached, exiting.');
      process.exit(1);
    });

    this.slack.rtm.on('error', async error => {
      logger.error('Received error event from Slack', error);
    });

    this.slack.rtm.on('message', async message => {
      // Ignore bot messages and people leaving/joining
      if (
        message.type === 'message' &&
        (!message.subtype || ALLOWED_SUBTYPES.indexOf(message.subtype) > -1)
      ) {
        this.sendToIRC(message);
      }
    });

    this.ircClient.on('message', (author, to, text) => {
      this.sendToSlack(author, to, text).then();
    });

    this.ircClient.on('notice', (author, to, text) => {
      const formattedText = `*${text}*`;
      this.sendToSlack(author, to, formattedText).then();
    });

    this.ircClient.on('action', (author, to, text) => {
      const formattedText = `_${text}_`;
      this.sendToSlack(author, to, formattedText).then();
    });

    this.ircClient.on('invite', (channel, from) => {
      logger.debug('Received invite:', channel, from);
      if (!this.invertedMapping[channel]) {
        logger.debug('Channel not found in config, not joining:', channel);
      } else {
        this.ircClient.join(channel);
        logger.debug('Joining channel:', channel);
      }
    });

    if (this.ircStatusNotices.join) {
      this.ircClient.on('join', (channel, nick) => {
        if (nick !== this.nickname) {
          this.sendToSlack(
            this.nickname,
            channel,
            `*${nick}* has joined the IRC channel`,
          ).then();
        }
      });
    }

    if (this.ircStatusNotices.leave) {
      this.ircClient.on('part', (channel, nick) => {
        this.sendToSlack(
          this.nickname,
          channel,
          `*${nick}* has left the IRC channel`,
        ).then();
      });

      this.ircClient.on('quit', (nick, reason, channels) => {
        channels.forEach(channel => {
          this.sendToSlack(
            this.nickname,
            channel,
            `*${nick}* has quit the IRC channel`,
          ).then();
        });
      });
    }
  }

  async parseText(text) {
    return text
      .replace(/\n|\r\n|\r/g, ' ')
      .replace(/<!channel>/g, '@channel')
      .replace(/<!group>/g, '@group')
      .replace(/<!everyone>/g, '@everyone')
      .replace(/<#(C\w+)\|?(\w+)?>/g, (match, channelId, readable) => {
        let name = readable;
        findChannelsById(channelId).then(channels => {
          if (channels) {
            name = `#${channels[0].name}`;
          } 
        });
        return name;
      })
      .replace(/<@([UW]\w+)\|?(\w+)?>/g, (match, userId, readable) => {
        let name = readable;
        this.slack.web.users.info({ user: userId }).then(resp => {
          if (resp.ok) {
            name = `@${resp.user.name}`;
          }
        });
        return name;
      })
      .replace(/<(?!!)([^|]+?)>/g, (match, link) => link)
      .replace(
        /<!(\w+)\|?(\w+)?>/g,
        (match, command, label) => `<${label || command}>`,
      )
      .replace(/:(\w+):/g, (match, emoji) => {
        if (emoji in emojis) {
          return emojis[emoji];
        }

        return match;
      })
      .replace(/<.+?\|(.+?)>/g, (match, readable) => readable)
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
  }

  isCommandMessage(message) {
    return this.commandCharacters.indexOf(message[0]) !== -1;
  }

  sendToIRC(message) {
    let channel;
    findChannelsById(message.channel).then(channels => {
      if (channels) {
        channel = channels[0];
      }
    });
    if (!channel) {
      logger.info(
        "Received message from a channel the bot isn't in:",
        message.channel,
      );
      return;
    }

    if (this.muteSlackbot && message.user === 'USLACKBOT') {
      logger.debug(`Muted message from Slackbot: "${message.text}"`);
      return;
    }

    let username;
    let mute = false;
    this.slack.web.users.info({ user: message.user }).then(resp => {
      if (resp.ok && resp.user) {
        if (this.muteUsers.slack.indexOf(resp.user.name) !== -1) {
          mute = true;
        }
        username = this.ircUsernameFormat.replace(
          /\$username/g,
          resp.user.name,
        );
      }
    });

    if (mute) {
      logger.debug(`Muted message from Slack ${user.name}: ${message.text}`);
      return;
    }

    const channelName = channel.is_channel ? `#${channel.name}` : channel.name;
    const ircChannel = this.channelMapping[channelName];

    logger.debug(
      'Channel Mapping',
      channelName,
      this.channelMapping[channelName],
    );
    let text;
    this.parseText(message.text).then(result => {
      text = result;
    });
    if (ircChannel) {
      if (this.isCommandMessage(text)) {
        const prelude = `Command sent from Slack by ${user.name}:`;
        this.ircClient.say(ircChannel, prelude);
      } else if (!message.subtype) {
        text = `${username}${text}`;
      } else if (message.subtype === 'file_share') {
        text = `${username}File uploaded ${message.file.permalink} / ${message.file.permalink_public}`;
        if (message.file.initial_comment) {
          text += ` - ${message.file.initial_comment.comment}`;
        }
      } else if (message.subtype === 'me_message') {
        text = `Action: ${user.name} ${text}`;
      }
      logger.debug('Sending message to IRC', channelName, text);
      this.ircClient.say(ircChannel, text);
    }
  }
  async findChannelsById(id) {
    try {
      resp = await this.slack.web.converstations.list({
        types: 'public_channel,private_channel',
      });
    } catch(e) {
      return [];
    }
    return resp.channels.filter(c => c.name === name);
  }
  async sendToSlack(author, ircChannelName, text) {
    const slackChannelName = this.invertedMapping[ircChannelName.toLowerCase()];
    if (slackChannelName) {
      const name = slackChannelName.replace(/^#/, '');
      const slackChannels = findChannelsById(name);
      if (!slackChannels) {
        return;
      }
      const slackChannel = slackChannels[0];

      if (!slackChannel.is_member && !slackChannel.is_group) {
        return;
      }

      if (this.muteUsers.irc.indexOf(author) !== -1) {
        logger.debug(`Muted message from IRC ${author}: ${text}`);
        return;
      }

      if (['ᛑ', 'talk42', 'slairck'].indexOf(author) !== -1) {
        const match = /^<(.+?)> /.exec(text);
        author = match[1];
        text = text.replace(match[0], '');
      }

      const members = [];
      const memberIDList = (
        await this.slack.web.converstations.members({
          channel: slackChannel.id,
        })
      ).members;
      for (const user of memberIDList) {
        resp = await this.slack.web.users.info({ user });
        members.push(resp.user);
      }

      const mappedText = members.reduce((current, member) => {
        const id = member.id;
        const username = member.name;
        current
          .replace(`@${username}`, username)
          .replace(username, `<@${id}|${username}>`);
      }, text);

      const options = {
        username: this.slackUsernameFormat.replace(/\$username/g, author),
        parse: 'full',
        icon_url: this.avatarUrl.replace(/\$username/g, author),
      };

      await this.slack.web.chat.postMessage(
        slackChannel.id,
        mappedText,
        options,
      );
    }
  }
}

export default Bot;
