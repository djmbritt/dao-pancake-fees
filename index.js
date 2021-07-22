const path = require("path")
const grpc = require("grpc")
const protoLoader = require("@grpc/proto-loader")
const ProtoBuf = require("protobufjs")
const { createDfuseClient } = require("@dfuse/client")

// Global required by dfuse client, only `node-fetch` is used actually
global.fetch = require("node-fetch")
global.WebSocket = require("ws")

const bstreamProto = loadProto("dfuse/bstream/v1/bstream.proto")
const ethProto = loadProto("dfuse/ethereum/codec/v1/codec.proto")

const bstreamService = loadGrpcPackageDefinition("dfuse/bstream/v1/bstream.proto").dfuse.bstream.v1

const blockMsg = bstreamProto.root.lookupType("dfuse.bstream.v1.Block")
const blockDetailsEnum = bstreamProto.root.lookupEnum("dfuse.bstream.v1.BlockDetails")
const ethBlockMsg = ethProto.root.lookupType("dfuse.ethereum.codec.v1.Block")

const blockDetailsLight = blockDetailsEnum.values["BLOCK_DETAILS_LIGHT"]
const blockDetailsFull = blockDetailsEnum.values["BLOCK_DETAILS_FULL"]

const blockHeight = 9321403

const PTOKENS_EFX_ADDRESS = '0xc51ef828319b131b595b7ec4b28210ecf4d05ad0'
const PANCAKESWAP_EFX_ADDRESS = '0xaf1db0c88a2bd295f8edcc8c73f9eb8bcee6fa8a'

const WBNB_ADDRESS = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c'

const PCS_CONTRACT_ADDRESS = '0x10ed43c718714eb63d5aa57b78b54704e256024e'
const PCS_ROUTER_ADDRESS = "0x7f4c8a6c2c1f8a9d6b8f9d2d5d8e5a0c3b9c5f5"


/**
 * from: string, signer or originator of the Call
 * to: string, target contract or address of the Call
 * nonce: number, the name of the action being executed
 * input: string, "0x"-prefixed hex of the input; the string will be empty if input is empty.
 * gas_price_gwei: number, gas price for the transaction, in GWEI.
 * gas_limit: number, gas limit, in units of computation.
 * erc20_from: string, the from field of an ERC20 Transfer; string empty when not an ERC20 Transfer.
 * erc20_to: string, the to field of an ERC20 Transfer; string empty when not an ERC20 Transfer.
 */


// const filterExpression = `erc20_from == "${WBNB_ADDRESS}"`
// const filterExpression = `erc20_to == "${WBNB_ADDRESS}"`
// const filterExpression = `erc20_to == "${PTOKENS_EFX_ADDRESS}"`
// const filterExpression = `erc20_from == "${PTOKENS_EFX_CONTRACT_ADDRESS}"`
// const filterExpression = `erc20_from == "${PTOKENS_EFX_CONTRACT_ADDRESS}" || erc20_to == "${PTOKENS_EFX_CONTRACT_ADDRESS}"`
// const filterExpression = `to == "${PCS_CONTRACT_ADDRESS}"`
// const filterExpression = `erc20_to == "${PCS_CONTRACT_ADDRESS} && erc20_from == "${PTOKENS_EFX_CONTRACT_ADDRESS}"`
// const filterExpression = `erc20_from == "${PCS_CONTRACT_ADDRESS}" || erc20_to == "${PCS_CONTRACT_ADDRESS}"`

const filterExpression = `erc20_to == "${PTOKENS_EFX_ADDRESS}"`




async function main() {
  if (process.argv.length <= 3) {
    console.error("Error: Wrong number of arguments")
    console.error("usage: node index.js <endpoint> <apiKey> [--full]")
    process.exit(1)
  }

  const endpoint = process.argv[2]
  const apiKey = process.argv[3]

  const dfuse = createDfuseClient({
    apiKey,
    network: endpoint.replace(/:[0-9]+$/, ""),
  })

  const client = new bstreamService.BlockStreamV2(endpoint, grpc.credentials.createSsl())
  const showFull = process.argv.length > 4 && process.argv[4] == "--full"

  console.log(`Filter Expression: ${filterExpression}`);
  
  try {
    await new Promise(async (resolve, reject) => {
      let stream

      try {
        const metadata = new grpc.Metadata()
        metadata.set("authorization", (await dfuse.getTokenInfo()).token)

        stream = client.Blocks(
          {
            start_block_num: blockHeight,
            stop_block_num: blockHeight + 1,
            details: blockDetailsFull,
            // include_filter_expr: filterExpression
          },
          metadata
        )

        stream.on("data", (data) => {
          const { block: rawBlock } = data
          if (rawBlock.type_url !== "type.googleapis.com/dfuse.ethereum.codec.v1.Block") {
            rejectStream(stream, reject, invalidTypeError(rawBlock.type_url))
            return
          }

          switch (data.step) {
            case "STEP_NEW":
              // Block is the new head block of the chain
              break
            case "STEP_UNDO":
              // Block has been forked out, should undo everything
              break
            case "STEP_IRREVERSIBLE":
              // Block is now irreversible, it's number will be ~360 blocks in the past
              break
          }

          const block = ethBlockMsg.decode(rawBlock.value)

          // The `transactionTraces` will contain only transaction that matches your filter expression above
          const transactionCount = block.transactionTraces.length

          let callCount = 0
          let matchingCallCount = 0

          block.transactionTraces.forEach((trace) => {
            trace.calls.forEach((call) => {
              // Call represents all internal calls of the transaction, the `call.index` with value `1` is the
              // "root" call which has the same input as the transaction.
              //
              // @see https://github.com/dfuse-io/proto-ethereum/blob/develop/dfuse/ethereum/codec/v1/codec.proto#L196
              callCount += 1

              // If the call's field `filteringMatched` is `true`, it means this call matched the filter
              // you used to request the blocks. You can use that to inspect the specific calls that matched
              // your filter.
              if (call.filteringMatched) {
                matchingCallCount += 1
              }
            })
          })

          console.log(
            `Block #${block.number} (${block.hash.toString(
              "hex"
            )}) - ${transactionCount} Matching Transactions, ${callCount} Calls (${matchingCallCount} matching filter)`
          )
          if (showFull) {
            console.log(JSON.stringify(block, null, "  "))
          }
        })

        stream.on("error", (error) => {
          rejectStream(stream, reject, error)
        })

        stream.on("status", (status) => {
          if (status.code === 0) {
            resolveStream(stream, resolve)
            return
          }

          // On error, I've seen the "error" callback receiving it, so not sure in which case we would do something else here
        })
      } catch (error) {
        if (stream) {
          rejectStream(stream, reject, error)
        } else {
          reject(error)
        }
      }
    })
  } finally {
    // Clean up resources, should be performed only if the gRPC client (`client` here) and/or the dfuse client
    // (`dfuse` here) are not needed anymore. If you have pending stream, you should **not** close those since
    // they are required to make the stream works correctly.
    client.close()
    dfuse.release()
  }
}

function loadGrpcPackageDefinition(package) {
  const protoPath = path.resolve(__dirname, "proto", package)

  const proto = protoLoader.loadSync(protoPath, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  })

  return grpc.loadPackageDefinition(proto)
}

function loadProto(package) {
  const protoPath = path.resolve(__dirname, "proto", package)

  return ProtoBuf.loadSync(protoPath)
}

function resolveStream(stream, resolver) {
  stream.cancel()
  resolver()
}

function rejectStream(stream, rejection, error) {
  stream.cancel()
  rejection(error)
}

function invalidTypeError(type) {
  return new Error(
    `invalid message type '${type}' received, are you connecting to the right endpoint?`
  )
}

main()
  .then(() => {
    console.log("Completed")
  })
  .catch((error) => {
    console.error("An error occurred", error)
  })
