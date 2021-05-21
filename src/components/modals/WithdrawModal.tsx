import * as React from "react";
import {
    Flex,
    ModalBody,
    ModalCloseButton,
    ModalHeader,
    Modal,
    ModalOverlay,
    ModalContent,
    FormLabel,
    NumberInput,
    NumberInputField,
    NumberInputStepper,
    NumberIncrementStepper,
    NumberDecrementStepper, FormControl, Button
} from "@chakra-ui/react";
import {useState} from "react";

const formControlStyle = {
    maxWidth: "35rem", marginBottom: "2rem"
}

const formLabelStyle = {
    color: "#004e87", fontSize: "0.8rem", margin: 0
}
const inputStyle = {
    border: "solid 1px #0094ff",
    backgroundColor: "white",
    borderRadius: 0,
    height: "3.5rem",
}

export default function WithdrawModal(props: {isOpen: boolean, onClose: (value: number) => void}) {
    const [amountOfGas, setAmountOfGas] = useState(0)

    const handleSubmit = (e: React.SyntheticEvent) => {
        e.preventDefault()
        props.onClose(amountOfGas)
    }

    return (
        <Modal isOpen={props.isOpen} onClose={() => props.onClose(amountOfGas)}>
            <ModalOverlay/>
            <ModalContent>
                <ModalHeader>Withdraw</ModalHeader>
                <ModalCloseButton/>
                <ModalBody>
                    <Flex as="form" onSubmit={handleSubmit} direction="column" align="center">
                        <FormControl style={formControlStyle} isRequired>
                            <FormLabel style={formLabelStyle}>Amount of Gas</FormLabel>
                            <NumberInput
                                value={amountOfGas}
                                onChange={(value) => setAmountOfGas(Number(value))}>
                                <NumberInputField style={inputStyle}/>
                                <NumberInputStepper>
                                    <NumberIncrementStepper/>
                                    <NumberDecrementStepper/>
                                </NumberInputStepper>
                            </NumberInput>
                        </FormControl>
                        <Button type="submit" w="100%" maxWidth="35rem" bg="#0094ff" textColor="white" fontSize="2rem" h="4rem"
                                _hover={{backgroundColor: '#0081dc'}}>
                            Withdraw
                        </Button>
                    </Flex>
                </ModalBody>
            </ModalContent>
        </Modal>
    );
};