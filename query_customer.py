import json
import subprocess
import os
import select
import sys

# Load environment variables from .env if exists
env = os.environ.copy()
if os.path.exists('.env'):
    with open('.env') as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                key, value = line.split('=', 1)
                env[key] = value.strip('"')

# Set ERPNext URL and credentials
env["ERPNEXT_URL"] = env.get("ERPNEXT_URL", "https://prevail-pantyhose-overvalue.ngrok-free.dev")
env["ERPNEXT_API_KEY"] = env.get("ERPNEXT_API_KEY", "")
env["ERPNEXT_API_SECRET"] = env.get("ERPNEXT_API_SECRET", "")
# Avoid npm cache issues
env["npm_config_cache"] = "/tmp/npmcache-test"

print("ERPNEXT_URL:", env["ERPNEXT_URL"], file=sys.stderr)
print("Has API Key:", bool(env["ERPNEXT_API_KEY"]), file=sys.stderr)
print("Has API Secret:", bool(env["ERPNEXT_API_SECRET"]), file=sys.stderr)

# Start MCP server
proc = subprocess.Popen(["npx", "-y", "@casys/mcp-erpnext"], 
                        stdin=subprocess.PIPE, 
                        stdout=subprocess.PIPE, 
                        stderr=subprocess.PIPE, 
                        env=env, 
                        text=True, 
                        bufsize=1)

def send(o):
    proc.stdin.write(json.dumps(o) + "\n")
    proc.stdin.flush()

def read_line(t=10):
    r, _, _ = select.select([proc.stdout], [],[], t)
    line = proc.stdout.readline().strip() if r else None
    if line is None:
        return None
    return line

# Initialize
send({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
    "protocolVersion": "2024-11-05",
    "capabilities": {},
    "clientInfo": {"name": "t", "version": "1"}
}})
init_response = read_line(60)
print("Initialize response:", init_response, file=sys.stderr)

# Send notifications/initialized
send({"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}})
notif_response = read_line(10)
print("Notifications/initialized response:", notif_response, file=sys.stderr)

# List tools to see what's available
send({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
tools_response = read_line(10)
print("Tools list response received:", bool(tools_response), file=sys.stderr)

# Parse tools response
try:
    tools_data = json.loads(tools_response)
    if "result" in tools_data and "tools" in tools_data["result"]:
        tools = tools_data["result"]["tools"]
        print(f"Found {len(tools)} tools", file=sys.stderr)
        # Look for customer balance or sales invoice tools
        customer_balance_tool = None
        sales_invoice_list_tool = None
        for tool in tools:
            if "customer" in tool["name"].lower() and "balance" in tool["name"].lower():
                print(f"Found customer balance tool: {tool['name']}", file=sys.stderr)
                customer_balance_tool = tool["name"]
            if "sales_invoice" in tool["name"].lower() and "list" in tool["name"].lower():
                print(f"Found sales invoice list tool: {tool['name']}", file=sys.stderr)
                sales_invoice_list_tool = tool["name"]
    else:
        print("Could not parse tools list", file=sys.stderr)
        print("Response:", tools_response[:200], file=sys.stderr)
except Exception as e:
    print(f"Error parsing tools: {e}", file=sys.stderr)
    print("Response:", tools_response[:200], file=sys.stderr)

# If we found a customer balance tool, we can use it directly
# But we need the customer name. Let's search for customer "Lan" first.
# We'll use erpnext_doc_list for Customer doctype
send({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {
    "name": "erpnext_doc_list",
    "arguments": {
        "doctype": "Customer",
        "filters": [["customer_name", "like", "%Lan%"]],
        "fields": ["name", "customer_name"],
        "limit": 10
    }
}})
customer_list_response = read_line(10)
print("Customer list response received:", bool(customer_list_response), file=sys.stderr)

# Parse customer list
try:
    customer_data = json.loads(customer_list_response)
    if "result" in customer_data and isinstance(customer_data["result"], list):
        customers = customer_data["result"]
        if customers:
            print(f"Found {len(customers)} customers matching 'Lan'", file=sys.stderr)
            for c in customers:
                print(f"  - {c.get('name')}: {c.get('customer_name')}", file=sys.stderr)
            # Use the first customer
            customer_name = customers[0].get("name")
            customer_display = customers[0].get("customer_name")
        else:
            print("No customers found matching 'Lan'", file=sys.stderr)
            customer_name = None
    else:
        print("Could not parse customer list", file=sys.stderr)
        print("Response:", customer_list_response[:200], file=sys.stderr)
        customer_name = None
except Exception as e:
    print(f"Error parsing customer list: {e}", file=sys.stderr)
    print("Response:", customer_list_response[:200], file=sys.stderr)
    customer_name = None

# If we have a customer, get their balance
if customer_name:
    # Try to use erpnext_customer_balance if available, else use sales invoice list
    if customer_balance_tool:
        send({"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {
            "name": customer_balance_tool,
            "arguments": {
                "customer": customer_name
            }
        }})
    elif sales_invoice_list_tool:
        # Fallback to sales invoice list and sum outstanding_amount
        send({"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {
            "name": sales_invoice_list_tool,
            "arguments": {
                "customer": customer_name,
                "filters": [["docstatus", "=", 1]],  # Only submitted invoices
                "fields": ["outstanding_amount"],
                "limit": 1000
            }
        }})
    else:
        print("Neither customer balance nor sales invoice list tool found", file=sys.stderr)
        balance_response = None
    
    if 'balance_response' not in locals() or balance_response is None:
        balance_response = read_line(10)
    print("Balance response received:", bool(balance_response), file=sys.stderr)
    
    # Parse balance
    try:
        balance_data = json.loads(balance_response)
        if "result" in balance_data:
            result = balance_data["result"]
            if isinstance(result, list):
                # Sum outstanding_amount
                total = sum(float(inv.get("outstanding_amount", 0)) for inv in result)
                print(f"Total outstanding amount for {customer_display}: {total} VND")
            else:
                # Might be a single value or different structure
                print(f"Balance result type: {type(result)}", file=sys.stderr)
                print(f"Balance result: {result}", file=sys.stderr)
                # Try to extract amount
                if isinstance(result, dict) and "outstanding_amount" in result:
                    total = float(result["outstanding_amount"])
                    print(f"Total outstanding amount for {customer_display}: {total} VND")
                elif isinstance(result, (int, float)):
                    total = float(result)
                    print(f"Total outstanding amount for {customer_display}: {total} VND")
                else:
                    print("Could not extract amount from result", file=sys.stderr)
        else:
            print("No result in balance response", file=sys.stderr)
            print("Response:", balance_response[:200], file=sys.stderr)
    except Exception as e:
        print(f"Error parsing balance: {e}", file=sys.stderr)
        print("Response:", balance_response[:200] if balance_response else "None", file=sys.stderr)
else:
    print("Could not determine customer", file=sys.stderr)

# Clean up
proc.terminate()
proc.wait()
