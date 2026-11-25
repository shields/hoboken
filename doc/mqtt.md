# MQTT Broker Connection

How Hoboken connects to the MQTT broker: the URL, the login, the topics it
needs, and what a refusal looks like. It opens one connection for Zigbee2MQTT
and WLED devices and separate MQTT 5 connections for heated bedding and for
curtains, all with the same credentials.

## URL

`mqtt.url` names the broker as `scheme://host[:port]`, such as
`mqtt://mosquitto:1883` or `mqtts://broker.example.com:8883`. The scheme is
`mqtt`, `mqtts`, `tcp`, `ssl`, `tls`, `ws`, or `wss`, the host is required, and
a port, if present, is 1 to 65535. A bare hostname does not work, because
mqtt.js requires a scheme, and neither does `host:port`, because mqtt.js reads
the host as the scheme. A Unix socket URL such as
`mqtt+unix:///run/mosquitto.sock` does not work either. Write a non-ASCII
hostname in punycode, such as `xn--bcher-kva.example`; `ws` and `wss` URLs also
accept it as written. A `ws` or `wss` URL needs a hostname rather than an IPv6
address, because mqtt.js writes the address without its brackets and cannot
connect.

Hoboken refuses to start with `mqtt.url is not a valid MQTT URL` when the URL
breaks these rules. The URL can carry credentials, and a URL that is not well
formed cannot be reliably stripped of them, so no part of it appears in that
error, the logs, the status page, the metrics, or a process warning. Hoboken
parses the URL as mqtt.js does, with Node.js's legacy `url.parse`, and again
with the WHATWG `URL` parser, and requires both to find the same host. That
rejects what `url.parse` alone accepts, such as a port above 65535 or a stray
character in the host, where `url.parse` drops the rest of the host and mqtt.js
connects to what remains. It also rejects an `@` in the path, query, or
fragment, because a password with an unencoded `/`, `?`, or `#` ends the host
there and leaves the username, or part of the password, as the host; write `%40`
for an `@` that belongs in a path or query. If mqtt.js still fails
synchronously while it creates a client, Hoboken reports only
`MQTT client could not be started` and the error code, because Node.js quotes the
URL in those errors.

## Authentication

Brokers that require a login take an optional `mqtt.username` and an
`mqtt.passwordFile` that names a file containing the password. Hoboken reads the
file once at startup as UTF-8, removes a leading byte order mark, and removes one
trailing line ending, either a line feed or a carriage return and line feed, so a
file made with `echo`, `kubectl create secret --from-file`, or a Windows editor
works as written. A lone trailing carriage return stays part of the password.
The file must be valid UTF-8; invalid bytes, including a UTF-16 file with a byte
order mark, fail startup instead of becoming a different password. Hoboken takes
the password from no other source and ignores any `MQTT_PASSWORD` environment
variable. The connection for Zigbee2MQTT and WLED devices and the heated bedding
and curtain connections use the same credentials.

Hoboken refuses to start when `mqtt.username` has no `mqtt.passwordFile`, when
`mqtt.passwordFile` has no `mqtt.username`, when the password file cannot be
read, is not valid UTF-8, or is empty (a file holding only a line ending, with or
without a byte order mark, is empty), when `mqtt.username` or
`mqtt.passwordFile` is not a non-empty string, when the username or password is
longer than 65535 bytes, when `mqtt.username` is combined with credentials in
`mqtt.url`, when `config.yaml` contains `mqtt.password`, or when `mqtt` has any
key other than `url`, `username`, and `passwordFile`, such as a misspelled `user`
or `passwd`. The error names the key but not its value. Keep the password out of
`config.yaml`, which is typically a ConfigMap.

Credentials embedded in `mqtt.url` as `scheme://user:password@host` keep working
when `mqtt.username` and `mqtt.passwordFile` are both unset. mqtt.js
percent-decodes them, so write `%`, `\`, `/`, `?`, and `#` in them as `%25`,
`%5C`, `%2F`, `%3F`, and `%23`. Left as they are, most of these make startup
fail with `mqtt.url is not a valid MQTT URL`, which names no cause, and a `%`
that is followed by two hexadecimal digits is decoded into a different password
without any error. mqtt.js also splits the decoded credentials at the last `:`
that has text on both sides, so percent-encoding cannot protect a `:` in a
password. Use `mqtt.username` and `mqtt.passwordFile` for such a password, and
for one with any other special character.

## Keeping the password secret

The logs and the status page show only the scheme, host, and port of `mqtt.url`,
never its credentials, path, or query. A YAML error or warning in `config.yaml`,
such as a syntax error, an unresolved tag, or a key that is a list or a mapping,
stops startup and is reported by its code, line, and column without the text of
the line, which can hold such credentials. An alias with no anchor is reported
without a position. The configured password never appears in logs, the status
page, metrics, or error messages. Rotating it takes a restart.

Use `mqtts://` unless the broker is on a trusted network, because `mqtt://`
sends the password unencrypted. `mqtt.passwordFile` can name any file that the
container can read, so treat `config.yaml` as being as trusted as the container.
Do not set `DEBUG` to a pattern that matches `mqttjs:client` or
`mqtt-packet:writeToStream`, such as `DEBUG=*`, `DEBUG=mqtt*`, or
`DEBUG=mqttjs*`, which makes the MQTT library print the password.

## Topic permissions

Brokers that restrict topics per user must grant Hoboken these topics:

- Zigbee2MQTT devices: read `<topic>`; write `<topic>/set` and `<topic>/get`.
- WLED devices: read `<topic>/g` and `<topic>/c`; write `<topic>/api`.
- Heated bedding: read `<prefix>/bridge/availability`,
  `<prefix>/bridge/heartbeat`, `<prefix>/<controller>/availability`, and each
  zone's `<prefix>/<controller>/<zone>` and `<prefix>/<controller>/<zone>/result`;
  write each zone's `<prefix>/<controller>/<zone>/set`. A group needs the topics
  of each of its zones and no others.
- Curtains: read `<prefix>/bridge/availability`, `<prefix>/bridge/heartbeat`,
  `<prefix>/<controller>/availability`, `<prefix>/<controller>`, and
  `<prefix>/<controller>/result`; write `<prefix>/<controller>/set`.

With an `acl_file`, Mosquitto accepts a subscription to a topic that the user
cannot read and then delivers nothing, so a missing read permission shows up as
a device that never reports state. It also drops a QoS 0 publish that the user
cannot write without telling the sender, so a missing write permission shows up
as a Zigbee2MQTT or WLED command that HomeKit reports as done while nothing
happens.

## Refused connections and subscriptions

When the broker refuses the connection, with or without `mqtt.username`, the
Zigbee2MQTT and WLED connection logs `MQTT error: Connection refused: ...`,
counts it in `hoboken_mqtt_errors_total`, and keeps retrying. It waits 1 second
before the first retry and doubles the wait with each further attempt up to 60
seconds. The wait returns to 1 second only after a connection has stayed up for
60 seconds, so a broker that accepts the login and then drops the session, such
as one that disconnects a client after a denied publish, is retried at the
growing interval rather than every second. The heated bedding and curtain
connections log an `mqtt_connection_error` event with the reason code, count it
in the same metric, and retry with the same doubling waits, each shortened at
random by up to 25 percent: the first retry comes 0.75 to 1 second after the
failure and the longest waits are 45 to 60 seconds. Correcting the broker
therefore takes effect without a restart.

A broker that enforces read permissions when a client subscribes, such as EMQX,
HiveMQ, or Mosquitto with its dynamic security plugin, refuses the subscription.
The Zigbee2MQTT and WLED connection then logs
`MQTT subscription refused for <topics>: ...`, naming only the topics the broker
refused, counts one error in `hoboken_mqtt_errors_total` for the subscription,
and keeps the connection open, so the topics the broker granted keep working
while the refused devices report no state. Every reconnect subscribes again and
reports a refusal again. The line says `failed` instead of `refused` and names
every topic when the subscription ended without a usable answer from the broker,
such as a connection that closed first. The heated bedding and curtain
connections treat a refused subscription as a failed connection: they log
`mqtt_subscription_failed`, count it in the same metric, and reconnect with
backoff.
